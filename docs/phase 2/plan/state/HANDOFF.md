# Handoff - P11-T01 in progress

- P10 is DONE: OTP, private photos and the proof completion guard. See [P10-T03](runs/20261113-1935-P10-T03.md). New deliveries snapshot `proof_required=true`; legacy rows stay false.
- Current: P11-T01 multi-role complaints (reporter_id/reporter_role backfill) and review replies/moderation.
- D19 requires pausing old stock writers, applying pending migrations and upgrading all writers before resuming or backfilling. Run the menu duplicate preflight first. No application DB migrations or backfill were run. Isolated PostgreSQL/Redis use ports 15433/16379.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
