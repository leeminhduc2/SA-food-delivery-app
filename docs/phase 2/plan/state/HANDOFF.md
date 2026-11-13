# Handoff - P13-T01 in progress

- P12 is DONE: restaurant metrics, driver estimates/backfill script (not run on application DB) and Admin KPIs. See [P12-T03](runs/20261113-2240-P12-T03.md).
- Current: P13-T01 Lowest ETA strategy (top-5 nearest, walking ETA through an injected Location port outside locks, labelled fallback to Nearest).
- D19 requires pausing old stock writers, applying pending migrations and upgrading all writers before resuming or backfilling. Run the menu duplicate preflight first. No application DB migrations or backfill were run. Isolated PostgreSQL/Redis use ports 15433/16379.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
