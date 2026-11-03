# Local operations and deployment boundaries

## Processes and data

The API and web UI use one Node process after building. Development uses Vite and the API separately. The PostgreSQL Compose volume `food_data` persists across container restarts. `docker compose stop` stops local PostgreSQL without deleting its data. The Docker entrypoint applies pending Prisma migrations with `prisma migrate deploy` before starting the API; a failure aborts startup. It never resets, seeds, or pushes schema changes. Seed data remains an explicit command.

Prisma Migrate is the only schema-change path. `prisma/schema.prisma` mirrors the live database, and `prisma/migrations/20261031000000_baseline` holds the equivalent DDL, including the CHECK constraints and partial indexes that Prisma cannot express. `prisma/migrations/20261103090000_delivery_routing` is a later additive migration for addresses, restaurant geocoding metadata and order delivery snapshots; the baseline was not edited. The existing development database was backed up, compared with the baseline, and marked as applied, so `deploy` only applies genuinely new migrations. Create future changes with `prisma migrate dev --create-only`, review and extend the SQL when CHECKs or partial indexes change, commit the migration, then apply it with `prisma migrate deploy`. Never use `prisma migrate reset` or `prisma db push` against an existing database. The adoption record, backup path, and verification results are in [PRISMA.md](PRISMA.md).

## Worker

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
