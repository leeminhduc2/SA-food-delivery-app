# Handoff - P11-T03 in progress

- P10 is DONE: OTP, private photos and the proof completion guard. See [P10-T03](runs/20261113-1935-P10-T03.md). New deliveries snapshot `proof_required=true`; legacy rows stay false.
- P11-T01 DONE: multi-role complaints and review replies/moderation. See [run](runs/20261113-2010-P11-T01.md).
- P11-T02 DONE: incident resolution and Admin fail command. See [run](runs/20261113-2040-P11-T02.md).
- Current: P11-T03 RefundRequest (Payment-owned), Admin approval, shared refund execution with reconciliation, retry/backoff and FAILED queue.
- D19 requires pausing old stock writers, applying pending migrations and upgrading all writers before resuming or backfilling. Run the menu duplicate preflight first. No application DB migrations or backfill were run. Isolated PostgreSQL/Redis use ports 15433/16379.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
