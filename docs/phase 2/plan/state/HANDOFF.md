# Handoff - P09-T02 complete

- Reserve, release and stock adjustment now share a locked idempotent movement path. Legacy stock changes require a reason and key; the UI sends deltas. See [run](runs/20261113-1700-P09-T02.md).
- Next: P09-T03 effective sellability, low-stock threshold/crossing alerts and ledger UI.
- D19 requires pausing old stock writers, applying pending migrations and upgrading all writers before resuming or backfilling. The menu duplicate preflight is also required. No application DB migrations or backfill were run. Isolated PostgreSQL/Redis use ports 15433/16379; build copy is `.tmp/p05-build-check`.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
