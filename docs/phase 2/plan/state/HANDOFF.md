# Handoff - P09-T01 complete

- Inventory opening, reserve, release and legacy stock edits now record movements under item locks. See [run](runs/20261113-1651-P09-T01.md). New items from owner create, import and seeds get opening balances.
- Next: P09-T02 idempotent stock adjustments, legacy stock adapter and shared inventory command path.
- D19 requires pausing old stock writers, applying pending migrations and upgrading all writers before resuming or backfilling. The menu duplicate preflight is also required. No application DB migrations or backfill were run. Isolated PostgreSQL/Redis use ports 15433/16379; build copy is `.tmp/p05-build-check`.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
