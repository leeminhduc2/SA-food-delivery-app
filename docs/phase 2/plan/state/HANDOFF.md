# Handoff - P12-T01 in progress

- P11 is DONE: multi-role support, review replies/moderation, incidents with Admin fail, and refund requests with a single executor. See [P11-T03](runs/20261113-2130-P11-T03.md).
- Current: P12-T01 restaurant metrics with explicit definitions, cohorts, coverage and `[from,to)` UTC filters.
- Refunds must not change Driver estimates (D07) when P12-T02 adds them.
- D19 requires pausing old stock writers, applying pending migrations and upgrading all writers before resuming or backfilling. Run the menu duplicate preflight first. No application DB migrations or backfill were run. Isolated PostgreSQL/Redis use ports 15433/16379.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
