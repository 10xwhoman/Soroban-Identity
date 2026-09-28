# Disaster Recovery

Disaster recovery (DR) plan for the Soroban Identity off-chain service: the
API server, its data directory, and the Redis cache. Tracks issue #959 (INFRA-05).

The contracts and the identity state they hold live on the Stellar network. No
outage of ours can lose them, and we have nothing to restore for them. This
plan covers what we run ourselves.

| Document | What it covers |
| --- | --- |
| [rpo-rto.md](rpo-rto.md) | Recovery point and recovery time objectives, per component |
| [backup-restoration.md](backup-restoration.md) | Restoring the data directory and Redis from backups |
| [service-recovery-runbook.md](service-recovery-runbook.md) | Step-by-step response for each failure scenario |
| [secondary-region.md](secondary-region.md) | The warm-standby region and how failover and failback work |
| [failover-testing.md](failover-testing.md) | Quarterly failover drill: schedule, procedure, pass criteria |
| [emergency-contacts.md](emergency-contacts.md) | Who to call, escalation order, external vendors |

| Automation | Purpose |
| --- | --- |
| [scripts/ship-backup.sh](scripts/ship-backup.sh) | Run `scripts/backup.sh` and upload the archive to the DR bucket |
| [scripts/recover.sh](scripts/recover.sh) | Restore the latest backup and bring up the service in a chosen region |
| [scripts/failover.sh](scripts/failover.sh) | Region failover: recover in the secondary region, then move Cloudflare traffic |
| [scripts/failover-drill.sh](scripts/failover-drill.sh) | Quarterly drill against staging, which times RTO/RPO and writes a report |
| [terraform/](terraform/) | Secondary-region stack and the cross-region replicated backup bucket |

## At a glance

- **Primary region:** `us-east-1`, which runs the production stack in `infra/terraform/environments/production`.
- **Secondary region:** `us-west-2`, a warm standby (pilot light). The VPC, ECS
  cluster and Redis are always provisioned there, with the service scaled to
  zero.
- **Backups:** `scripts/backup.sh` runs hourly and writes to an S3 bucket in the
  primary region, which replicates to the secondary region within 15 minutes.
- **Traffic:** Cloudflare (`infra/cloudflare/worker.js`) fronts both regions.
  Failover repoints `STABLE_ORIGIN`.
- **Targets:** Tier 1 has RPO 1 h and RTO 1 h for a region loss. See [rpo-rto.md](rpo-rto.md).

## Declaring a disaster

Any on-call engineer may declare a DR event when either of these holds:

1. The production API has been unavailable, or its error rate has been above
   50%, for 15 minutes, and the cause is not a bad deploy that a rollback fixes.
2. Data in the data directory is lost or corrupted and cannot be repaired in
   place.

Once declared, open an incident channel, page the Incident Commander (see
[emergency-contacts.md](emergency-contacts.md)), and follow the matching
scenario in the [runbook](service-recovery-runbook.md).

## Known gaps

The review of the current infrastructure found these gaps. Until each one is
closed, the objectives in [rpo-rto.md](rpo-rto.md) are targets rather than
guarantees.

| Gap | Impact | Remediation |
| --- | --- | --- |
| On ECS Fargate, `DATA_DIR` is on ephemeral task storage | A task replacement loses every write since the last backup, and tasks do not share state | Mount EFS at `DATA_DIR` in `infra/terraform/modules/app` and point `backup.sh` at it |
| `infra/terraform` defines no load balancer | The origin that Cloudflare targets is not managed in code, so failover needs the secondary origin URL supplied by hand | Add an ALB to `modules/app` and expose its DNS name as an output |
| `infrastructure/backup/restore.sh` runs `tar -xzf` on the `.rdb.gz` files that `infrastructure/backup/backup.sh` writes | Restoring Redis with that pair fails | DR uses `scripts/backup.sh` / `scripts/restore.sh` exclusively; retire the `infrastructure/backup` pair |
| ElastiCache snapshots stay in their own region | Redis cannot be restored cross-region from snapshots | This is acceptable because Redis is a rebuildable cache (see [rpo-rto.md](rpo-rto.md)) |
