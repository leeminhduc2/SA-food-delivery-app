# Handoff - P10-T03 in progress

- OTP and private photo proofs are complete. See [P10-T01](runs/20261113-1840-P10-T01.md) and [P10-T02](runs/20261113-1905-P10-T02.md).
- Current: P10-T03 `proof_required` snapshot on new deliveries, DELIVERED guard, driver proof UI.
- D19 requires pausing old stock writers, applying pending migrations and upgrading all writers before resuming or backfilling. Run the menu duplicate preflight first. No application DB migrations or backfill were run. Isolated PostgreSQL/Redis use ports 15433/16379.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
