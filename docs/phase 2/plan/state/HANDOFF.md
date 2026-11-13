# Handoff - P14-T01 in progress

- P13 is DONE: Lowest ETA and Balanced Load behind `ASSIGNMENT_STRATEGY` (default NEAREST). See [P13-T03](runs/20261113-2314-P13-T03.md).
- Current: P14-T01 provider circuit breaker (5 failures, open 30 s, one half-open probe), bounded read retries, backlog health and Redis-loss fallback evidence.
- D19 requires pausing old stock writers, applying pending migrations and upgrading all writers before resuming or backfilling. Run the menu duplicate preflight first. No application DB migrations or backfill were run. Isolated PostgreSQL/Redis use ports 15433/16379.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
