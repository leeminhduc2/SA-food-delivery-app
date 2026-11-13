# Handoff - phase 2 complete

- P00-P14 DONE. Final evidence: [P14-T02](runs/20261114-0020-P14-T02.md) (fresh-environment CI) and [P14-T03](runs/20261114-0030-P14-T03.md) (migration rehearsal, coverage, runbook).
- Reproduce the gate: `bash scripts/ci-local.sh` (throwaway PostgreSQL/Redis, `npm ci`, typecheck, build, OpenAPI, format, `npm test`, both Playwright suites, Compose check). Use `SKIP_INSTALL=1` when `node_modules` is current; on Windows, stop any running dev server first if `prisma generate` reports EPERM.
- Before using an existing database: stop the API/worker, back up, pause stock writers (D19), run `scripts/preflight-driver-assignments.ts` and `scripts/preflight-menu-groups.ts`, `npm run db:migrate`, then `scripts/backfill-stock-openings.ts` and `scripts/backfill-earnings.ts`. None of this was run against the application database.
- Deferred (unchanged): EXT01–EXT06 in [DEFERRED_EXTERNALS](../DEFERRED_EXTERNALS.md). Nothing here is production-ready.
- Next safe action: none inside the assigned scope. Opening a deferred item needs a new phase with its own decisions, contracts and acceptance criteria.
