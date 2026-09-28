# Backup Restoration

How to get data back from a backup during a DR event. Backup creation itself is
covered in [docs/backup-restore.md](../../docs/backup-restore.md).

## What gets backed up, and where it goes

`scripts/backup.sh` writes a single `soroban-identity-backup-<UTC>.tar.gz`
archive with this layout:

```
manifest.json      what was captured, when, from which host
data/              the full DATA_DIR (credentials, webhooks, logs, API keys, audit)
config/            env files present on the host
redis-dump.rdb     Redis snapshot (only when --redis-url was given)
```

[`scripts/ship-backup.sh`](scripts/ship-backup.sh) wraps it and uploads the
archive to the DR bucket:

| Bucket | Region | Purpose |
| --- | --- | --- |
| `soroban-identity-dr-backups-us-east-1` | us-east-1 | Primary: every archive is uploaded here |
| `soroban-identity-dr-backups-us-west-2` | us-west-2 | Replica: S3 Replication Time Control, 15-min SLA |

Both buckets have versioning on, encryption with KMS, all public access
blocked, and a 90-day expiry for noncurrent versions. The replica also has
Object Lock (governance mode, 30 days), so a compromised primary account cannot
delete it. They are defined in [terraform/backups.tf](terraform/backups.tf).

Schedule: hourly, from a scheduled ECS task or the host crontab:

```cron
0 * * * *  /opt/soroban-identity/infrastructure/dr/scripts/ship-backup.sh >> /var/log/dr-backup.log 2>&1
```

## Choosing a backup

```bash
# Latest archive in the region you are restoring into
aws s3api list-objects-v2 --bucket soroban-identity-dr-backups-us-west-2 \
  --prefix archives/ --query 'sort_by(Contents,&LastModified)[-1].Key' --output text

# Everything from the last 24 h, when you need to go back to before a corruption
aws s3api list-objects-v2 --bucket soroban-identity-dr-backups-us-west-2 --prefix archives/ \
  --query "Contents[?LastModified>='$(date -u -d '-24 hours' +%Y-%m-%dT%H:%M:%S)'].[Key,LastModified]" --output table
```

For **data corruption**, pick the newest archive taken *before* the corrupting
event. Use the audit log (`GET /admin/audit-logs`) or the `manifest.json`
timestamps to find that point. Always run a dry-run first:

```bash
aws s3 cp s3://soroban-identity-dr-backups-us-west-2/archives/<key> /tmp/restore.tar.gz
scripts/restore.sh /tmp/restore.tar.gz --dry-run
```

## Restoring the data directory

Automated path, which also brings the service up:

```bash
infrastructure/dr/scripts/recover.sh --region us-west-2 --data-dir /mnt/soroban-data
```

Manual path:

1. Stop writers. Scale the ECS service to 0, or stop the server process, so
   nothing writes while you restore.
2. Download the archive (see above) and verify it:
   `gzip -t /tmp/restore.tar.gz && tar -tzf /tmp/restore.tar.gz manifest.json`.
3. Restore:
   `scripts/restore.sh /tmp/restore.tar.gz --data-dir "$DATA_DIR" --force`.
   `--force` moves the existing directory to `<data-dir>.pre-restore-<ts>`.
   Nothing is deleted, so a mistaken restore can itself be undone.
4. Start the service and verify it (see [Verification](#verification)).

## Restoring Redis

Redis is a cache, so the default is to **not restore it**. Start the service
against an empty Redis and let the caches warm. Restore Redis only when you
need to recover queued jobs from the backed-up snapshot.

| Situation | Action |
| --- | --- |
| Primary node failure | None. ElastiCache fails over automatically (multi-AZ in production) |
| Cluster lost, same region | `aws elasticache create-replication-group --snapshot-name <latest-auto-snapshot> ...`, or `terraform apply` for a fresh empty cluster |
| Region lost | Use the standby cluster in the secondary region, which starts empty |
| Need queued jobs back | `scripts/restore.sh <archive> --redis-url <url>` on a host that can write the Redis data dir. This does **not** work against ElastiCache. Instead, replay the jobs from `redis-dump.rdb` with `rdb --command json` |

## Restoring secrets and config

The archive's `config/` directory holds env files as they were on the host.
In ECS, the secret manager is the source of truth, not these files. Use them
only to diff against what is currently configured:

```bash
tar -xzf /tmp/restore.tar.gz -C /tmp/restore config/
diff <(sort /tmp/restore/config/server/.env) <(aws ssm get-parameters-by-path ... | to-env | sort)
```

If you suspect the secrets are compromised, rotate them. Do not restore them.
See the runbook scenario *Credential or key compromise*.

## Verification

A restore is complete only when every check passes:

```bash
BASE=https://<origin>
curl -fsS "$BASE/health"                        # 200, status ok
curl -fsS "$BASE/ready"                         # 200: Redis and RPC reachable
curl -fsS -H "x-api-key: $ADMIN_KEY" "$BASE/admin/api-keys?limit=1" | jq '.pagination.total_count'
curl -fsS "$BASE/credentials?limit=1" | jq '.pagination.total_count'
curl -fsS -H "x-api-key: $ADMIN_KEY" "$BASE/admin/audit-logs?limit=1" | jq '.entries[0].timestamp'
```

Compare the counts against the `manifest.json` of the restored archive, and
confirm that the newest audit entry falls within RPO of the incident start.
Record the achieved RPO (incident start − newest restored entry) in the
incident log.
