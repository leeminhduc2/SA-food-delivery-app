# Handoff - P08 complete

- Restaurant rejection reuses cancellation compensation, audits and notifies once, and remains CANCELLED. See [run](runs/20261113-1645-P08-T03.md). P08 exit checks passed.
- Next: P09-T01 inventory opening balance and movement ledger.
- Run the menu duplicate preflight before deploying the pending additive P07/P08 migrations. No application DB migrations were run. Isolated PostgreSQL/Redis use ports 15433/16379; build copy is `.tmp/p05-build-check`.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
