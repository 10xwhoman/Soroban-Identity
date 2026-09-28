# Quarterly Failover Testing

A DR plan that has never been exercised doesn't count as a plan. Once a
quarter, we run a failover drill that measures real RTO and RPO against
[rpo-rto.md](rpo-rto.md).

## Schedule

| Quarter | Week | Drill | Environment |
| --- | --- | --- | --- |
| Q1 | 2nd week of February | Full region failover and failback | staging |
| Q2 | 2nd week of May | Data corruption restore (scenario 5) | staging |
| Q3 | 2nd week of August | Full region failover and failback | staging |
| Q4 | 2nd week of November | Game day: an unannounced scenario, picked by the IC | staging, plus a read-only production restore check |

Drills run on a Tuesday or Wednesday, during working hours, never during a
release freeze or within 48 h of a major release. Put them in the team calendar
at the start of each quarter.

## Roles

- **Drill lead:** runs the scripts and keeps the timeline.
- **Observer:** times each step independently and notes every point where the
  runbook was unclear or wrong.
- **IC stand-in:** makes the go/no-go calls as they would be made in a real
  event.

## Procedure

```bash
# 1. Announce in #eng and on the staging status page.
# 2. Run the drill. It times each phase and writes a report.
infrastructure/dr/scripts/failover-drill.sh --env staging --scenario region
#    or: --scenario restore
# 3. Fail back (the region scenario does this automatically unless --no-failback).
# 4. Commit the generated report.
git add infrastructure/dr/drills/ && git commit -m "docs(dr): <quarter> failover drill"
```

The drill script:

1. Seeds a marker record, a webhook named `dr-drill-<timestamp>`, so RPO can be
   measured end to end.
2. Ships a backup, then records the time it lands in the replica bucket, which
   is the replication lag.
3. Runs `failover.sh` against the staging stacks and times each phase.
4. Checks that the marker record exists after the restore.
5. Fails back, unless `--no-failback` is given.
6. Writes `drills/<YYYY>-Q<N>-<scenario>.md` with the timings and the outcome.

## Pass criteria

| Check | Pass |
| --- | --- |
| Measured RTO (declare → verified in secondary) | ≤ 1 h |
| Measured RPO (marker time → newest restored data) | ≤ 1 h |
| Marker record present after restore | Yes |
| All [verification checks](backup-restoration.md#verification) | Pass |
| Failback completed with data from the secondary intact | Yes |
| Runbook steps needing improvisation | 0, or each one filed as an issue |

A failed drill opens an issue labelled `dr` and `priority:high`. The next
quarter's drill repeats the failed scenario.

## Report template

`failover-drill.sh` generates this automatically. Fill in the last two sections
by hand.

```markdown
# DR drill — 2026-Q4 — region

- Date: 2026-11-10
- Environment: staging
- Drill lead / observer:

| Phase | Started | Duration |
| --- | --- | --- |
| backup shipped | ... | ... |
| replication | ... | ... |
| restore | ... | ... |
| scale-up | ... | ... |
| traffic switch | ... | ... |
| **total RTO** | | ... |

- Measured RPO: ...
- Marker present: yes/no
- Result: PASS/FAIL

## What went wrong
## Follow-up issues
```
