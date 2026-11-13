# Handoff - P08-T01 complete

- Restaurant owners can set phone and structured Vietnam-local hours. Quote and stock reservation check the schedule using DB time. See [run](runs/20261113-1629-P08-T01.md). Legacy hours remain display-only.
- Next: P08-T02 menu groups with case-insensitive uniqueness, non-empty delete guard and legacy duplicate preflight.
- Additive P07-T02 and P08-T01 migrations must be applied before deployment; no application DB migrations were run. Test PostgreSQL/Redis containers use ports 15433/16379; isolated build copy is `.tmp/p05-build-check`.
- Repository-wide format check still reports two untouched baseline documents listed in the P06-T03 run.
