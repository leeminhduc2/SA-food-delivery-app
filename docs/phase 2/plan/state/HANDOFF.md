# Handoff - P08-T02 complete

- Menu group CRUD has normalized uniqueness, archived-item delete guards and a safe duplicate preflight. See [run](runs/20261113-1636-P08-T02.md).
- Next: P08-T03 restaurant rejection, compensation and owner UI.
- Run the read-only menu preflight before the new uniqueness migration. P07-T02 and P08 migrations must be applied before deployment; no application DB migrations were run. Isolated PostgreSQL/Redis use ports 15433/16379 and the build copy is `.tmp/p05-build-check`.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
