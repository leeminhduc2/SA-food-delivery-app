# Local operations and deployment boundaries

## Processes and data

The API and web UI use one Node process after building. Development uses Vite and the API separately. The PostgreSQL Compose volume `food_data` persists across container restarts. `docker compose stop` stops local PostgreSQL without deleting its data. The Docker entrypoint applies pending Prisma migrations with `prisma migrate deploy` before starting the API; a failure aborts startup. It never resets, seeds, or pushes schema changes. Seed data remains an explicit command.

Prisma Migrate is the only schema-change path. `prisma/schema.prisma` mirrors the live database, and `prisma/migrations/20261031000000_baseline` holds the equivalent DDL, including the CHECK constraints and partial indexes that Prisma cannot express. `prisma/migrations/20261103090000_delivery_routing` is a later additive migration for addresses, restaurant geocoding metadata and order delivery snapshots; the baseline was not edited. The existing development database was backed up, compared with the baseline, and marked as applied, so `deploy` only applies genuinely new migrations. Create future changes with `prisma migrate dev --create-only`, review and extend the SQL when CHECKs or partial indexes change, commit the migration, then apply it with `prisma migrate deploy`. Never use `prisma migrate reset` or `prisma db push` against an existing database. The adoption record, backup path, and verification results are in [PRISMA.md](PRISMA.md).

## Worker

Live notifications use Server-Sent Events at `/api/notifications/stream`. Each instance holds its own connections and subscribes once to the Redis channel `notifications`. Redis carries signals only: a message lost while no subscriber is connected is recovered when the client reconnects and replays from the inbox. Set `REDIS_URL` to enable the stream. Each user may hold five streams, and an instance accepts at most `STREAM_MAX_CONNECTIONS` (default 10000). On SIGTERM, open streams close before the server stops. A load balancer in front of the API must not buffer responses or time out idle connections shorter than 25 seconds, and HTTP/1.1 clients are limited to six connections per origin, so use HTTP/2 at the edge for many tabs.

Every three seconds, the API process polls payment work and then the notification outbox. A local guard prevents overlapping loops. Multiple processes are safe for the simulator because provider references, payment event identities, state locks, and inbox identities are persistent. Outbox consumers claim rows with `FOR UPDATE SKIP LOCKED`. A real payment adapter must preserve idempotency for concurrent create/query/refund calls.

Provider calls time out after three seconds by default (`PROVIDER_TIMEOUT_MS`). PostgreSQL statements time out after ten seconds. Pending/expired references and refund work have a persisted next-poll timestamp; expiry releases reservations even when provider calls fail. A busy or unreachable provider can delay a batch. Large-scale deployments should separate and bound worker concurrency, monitor lag, and review timeouts. Payment refunds remain pending until provider confirmation. Notification failures retry up to five times, with a 30-second delay; exhausted records remain visible to operations.

## Observability

Structured request logs include request ID, method, path, response status, and duration; they omit request bodies/passwords. Responses carry `X-Request-Id`. Business history carries order/entity/actor data, while audit logs record sensitive actions. `/api/metrics` is admin-only and reports per-process request counts, server errors, and rolling p95/p99 latency. Admin overview exposes reconciliation and notification backlog. These are foundations for instrumentation, not a deployed alerting/tracing platform.

The checked local browse smoke test used 200 requests at concurrency 20 with zero errors and approximately 103 ms p95 (157 ms p99) on the development machine after the Prisma migration. The dataset contains only three kitchens. It does not substantiate production capacity or availability; load-test representative data and concurrent checkout/provider behavior before release.

## Backup and restore smoke test

Use PostgreSQL client tools matching your server. The following avoids PowerShell binary-redirection corruption by letting `pg_dump` write its archive inside the container, then copying the archive out. Use an appropriate protected backup location instead of committing customer data.

```powershell
docker compose exec -T db pg_dump -U food -d food_delivery -Fc -f /tmp/food_delivery.dump
docker compose cp db:/tmp/food_delivery.dump ./food_delivery.dump
docker compose exec -T db createdb -U food food_restore_check
docker compose exec -T db pg_restore -U food -d food_restore_check --no-owner /tmp/food_delivery.dump
docker compose exec -T db psql -U food -d food_restore_check -c "SELECT count(*) FROM restaurants; SELECT count(*) FROM users;"
```

Choose a fresh scratch database name for each rehearsal. Confirm expected tables, counts and a representative order/payment/history join. Record backup duration, restore duration and data age. Secure/encrypt backups and define retention, offsite storage, RPO and RTO before deployment. The local rehearsal is not an ongoing backup service.

### Backup storage policy

Backups contain customer data and are operational artifacts, not source code. `backups/` and `*.dump` are listed in `.gitignore`, and no backup is tracked by Git; never force-add one. Keep working archives outside the repository and outside folders that sync or share automatically.

- Encrypt archives at rest (for example with an encrypted volume or `age`/GPG) and in transit; limit access to operators who can perform a restore.
- Proposed starting retention: 7 daily, 4 weekly and 12 monthly copies. Adjust to the agreed RPO/RTO and verify a restore before relying on any rotation.
- Record backup time, size, checksum, migration version and the result of the restore rehearsal separately from the archive.
- Never put credentials or customer data in Git, CI logs, tickets, chat or documentation.

The pre-adoption dump under `backups/` is left in place. Moving or deleting it requires confirming that an encrypted copy exists outside this workspace.

A local dump/restore rehearsal was completed during implementation: the restored database contained all three seeded restaurants and six seeded accounts. This checks basic archive restorability; it does not establish a production recovery objective or verify recovery of a large transactional dataset.

## Delivery providers

The default geocoder is Photon (`GEOCODING_PROVIDER=photon`); a Nominatim adapter is also supported. Walking routes use Valhalla with `costing=pedestrian` at `VALHALLA_BASE_URL`. These public OpenStreetMap-based endpoints are for development and demonstration. They have no availability guarantee, and Nominatim was unreachable from this workspace during verification. Configure a contracted or self-hosted provider and monitor its latency/errors before production.

Catalog requests use a saved address to look up walking routes. Lookups are cached (default 10 minutes), deduplicated in flight, capped at `ROUTING_MAX_CONCURRENCY` (3), and bounded per provider call (`ROUTING_TIMEOUT_MS`, 6 seconds) and per catalog request (`DELIVERY_LOOKUP_BUDGET_MS`, 8 seconds). A failed or slow route leaves that restaurant without distance/fee while the rest of the catalog still renders; unsupported and failed routes sort last. Geocoding results are cached for 24 hours and public-provider calls are serialized at `GEOCODING_MIN_INTERVAL_MS` to respect usage policy. A provider failure never overwrites a saved address or a restaurant's address, and checkout refuses to charge a zero fee when the route is unavailable. For an outage affecting all candidates, customers can still browse; checkout returns `DELIVERY_ROUTE_UNAVAILABLE`.

Map tiles are requested by the browser from OpenStreetMap by default, with attribution. Configure `VITE_MAP_TILE_URL` and `VITE_MAP_TILE_ATTRIBUTION` at build time for another tile service. The application does not proxy or cache tiles. Browser Geolocation is optional and only requested after the customer clicks **Use current location**.

## Before accepting real orders

Supply a real provider implementation, production database credentials and an explicit origin allowlist; disable demo mode. The current production startup guard rejects `PAYMENT_MODE=simulated`. Replace the generic callback contract with the selected provider's signing and transaction-verification rules; implement actual query/refund semantics and exercise ambiguous outcomes. Deploy behind TLS, configure proxy trust deliberately, use secure cookies, provision the initial administrator out of band, and replace per-process rate limiting with ingress/shared enforcement if scaling out.

Confirm the demo address/service-area policy and fee formula with the business, select production geocoding/routing and map-tile providers, configure actual notifications as needed, agree on retention/refund policies, and wire alerting and backup automation. Neither the example credentials nor the simulator should be exposed publicly. The source specification intentionally leaves these deployment decisions open.

## Phase 2 upgrade and recovery

This is a **local, single-instance demo** with **simulated money**, **private local photo storage** and **walking routes**. Nothing below makes it production-ready; real payment/refund providers, payouts, object storage, motorbike routing and SLOs remain deferred (see `docs/phase 2/plan/DEFERRED_EXTERNALS.md`).

### Upgrading an existing database

1. Back up the database (see above) and stop the API and worker. Pause every stock writer: the inventory ledger cutover (D19) must not see writes from an older release.
2. Run the preflights against the target schema and resolve every reported conflict:
   `npx tsx scripts/preflight-driver-assignments.ts` (one open trip per driver) and `npx tsx scripts/preflight-menu-groups.ts` (case-insensitive menu names).
3. `npm run db:migrate`. Each phase 2 migration is additive. If a migration fails (for example an unresolved double trip), it rolls back; fix the data, mark it with `npx prisma migrate resolve --rolled-back <migration>` and deploy again. Never reset, drop or edit an applied migration.
4. Backfills, then start the new release: `npx tsx scripts/backfill-stock-openings.ts` (opening balance per item, idempotent) and `npx tsx scripts/backfill-earnings.ts` (estimates only where the final driver, delivery time and fee are known; the JSON report counts the rest). Deliveries created before the upgrade keep `proof_required=false`; payments already refund-pending or refunded get a `LEGACY` refund operation and are never refunded twice.

`tests/phase2-migration-rehearsal.test.ts` rehearses exactly this on throwaway schemas: a conflicting legacy database stops safely and resumes after the fix; a clean legacy database keeps orders, items, payments, reviews and history, and both backfills are idempotent.

### Configuration added in phase 2

`ASSIGNMENT_STRATEGY` (`NEAREST` default, `LOWEST_ETA`, `BALANCED_LOAD`; an unknown value stops startup), `DELIVERY_PROOF_*` (proof requirement for new deliveries, OTP limits, photo size, 30-day retention and the private storage directory `.data/delivery-proofs`, which must not be served statically or shared between instances), `REFUND_MAX_ATTEMPTS` (5) and `EXTERNAL_BREAKER_FAILURES` / `EXTERNAL_BREAKER_OPEN_SECONDS` (5 / 30). All have safe defaults in `.env.example`.

### Watching and recovering background work

- **System health** in the Admin workspace (`GET /api/admin/health/backlog`) lists each durable queue — notifications, refunds, assignment searches, driver invalidation, payment reconciliation, proof upload cleanup — with waiting/failed counts, next run and last error, plus provider breaker state and the last result of each worker stage. Admins receive at most one `BACKLOG_ATTENTION` notification per queue per hour while a queue is overdue or has failures. Breaker and stage state are per process.
- **Payment and routing outages**: after five consecutive failures a provider breaker opens for 30 seconds; calls fail fast and one probe tests recovery. Business answers (validation, "no route") never open it. Status reads retry at most twice inside a two-second budget; money movement is never retried blindly.
- **Refunds**: one operation per payment drives cancellations, late payments and Admin-approved refunds. A refund is marked refunded only after the provider confirms. After five failed attempts (30/60/120/240 s apart) it is FAILED, the payment stays refund-pending and flagged for reconciliation; an Admin retries it with a reason. A worker that dies mid-refund leaves a lease that expires; the next worker queries the provider by the stable reference before calling refund again.
- **Assignment searches and invalidation** use leases; a dead worker's claim is resumed after its lease expires without duplicating offers. Ranking and route lookups never hold Order or Driver locks.
- **Delivery failure after pickup**: if a driver becomes unavailable after pickup, an operational incident opens; an Admin closes the trip as FAILED (`POST /api/admin/deliveries/:id/fail`), which releases the driver. Items are never restocked after pickup and nothing is redelivered.
- **Photo proofs**: files are written before their database row; a failed or interrupted upload leaves a staging row that the cleanup stage removes with retries. Bytes are purged 30 days after the trip ends unless a complaint or incident is open; metadata and audit stay.
- **Redis**: losing Redis never blocks a database commit. Clients poll snapshots (also while an EventSource is still connecting) until the stream returns.

### Isolated integration tests

Database integration tests require an explicit `TEST_DATABASE_URL` pointing to a disposable test database. They never fall back to `DATABASE_URL`. Each test process creates a randomly named schema, verifies that both pg and Prisma connect to that schema before migrations, and removes only the schema it created. Set `DOTENV_CONFIG_PATH` to a non-existent path when invoking tests so the developer's `.env` is not loaded. Use `REDIS_URL` for a disposable Redis; the Redis test uses a unique channel and closes connections on failure. CI starts both services. `scripts/ci-local.sh` starts temporary services or accepts `CI_DATABASE_URL` and `CI_REDIS_URL`; it does not modify `.env`. With `CI=true` or `REQUIRE_REDIS=1`, `tests/ci-environment.test.ts` fails instead of letting Redis tests skip. Both CI and `ci-local.sh` (unless `SKIP_E2E=1`) run the Playwright suites against an isolated E2E schema with deterministic geocoding/routing, once normally and once with `ASSIGNMENT_AUTOMATION_ENABLED=true` for the automatic offer flow; traces and screenshots are kept on failure.
