# Handoff - P14-T02 in progress

- P14-T01 DONE: provider breakers, bounded read retries, backlog health and alerts. See [run](runs/20261113-2350-P14-T01.md).
- Current: P14-T02 CI with PostgreSQL + Redis services, required Redis integration, E2E (default and automation-enabled) with artifacts on failure.
- D19 requires pausing old stock writers, applying pending migrations and upgrading all writers before resuming or backfilling. Run the menu duplicate preflight first. No application DB migrations or backfill were run. Isolated PostgreSQL/Redis use ports 15433/16379.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run; P14-T02 must make the full format check pass.
