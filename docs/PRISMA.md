# Prisma migration notes

The server's database access layer was migrated from `node-postgres` (`pg`) plus
hand-written SQL to **Prisma ORM 6.19.3** (`prisma-client-js`) while keeping the
same PostgreSQL database, schema, identifiers, HTTP responses, and layering.

## Architecture audit

Before the migration, every HTTP route called a service, the service called a
repository, and every repository used a shared `pg.Pool` with parameterised SQL.
Transactions were managed by `BEGIN`/`COMMIT` on a checked-out client.

After the migration the same layering holds:

```text
server/api/*.routes.ts        HTTP only
server/services/*             business rules, transactions
server/repositories/*         Prisma Client queries
server/domain/*               pure types, errors, authorization, Zod schemas
server/db.ts                  one PrismaClient, transaction helper, row locks
```

Services no longer receive a pool. `transaction()` from `server/db.ts` opens an
interactive Prisma transaction (`$transaction(fn)`), and every repository
accepts the transaction-scoped `DB` client (`Prisma.TransactionClient`) with
`prisma` as the default.

## Configuration

| Item             | Value                                                                  |
| ---------------- | ---------------------------------------------------------------------- |
| Prisma CLI       | `prisma` 6.19.3 (devDependency)                                        |
| Client           | `@prisma/client` 6.19.3 (dependency)                                   |
| Schema           | [`prisma/schema.prisma`](../prisma/schema.prisma)                      |
| Datasource       | PostgreSQL, `env("DATABASE_URL")`                                      |
| Generator        | `prisma-client-js`                                                     |
| Naming           | Existing `snake_case` table and column names are preserved via `@@map` |
| Migrations       | [`prisma/migrations/`](../prisma/migrations) (baseline only)           |
| Client singleton | [`server/db.ts`](../server/db.ts)                                      |

The schema was produced by `prisma db pull` against the existing database and
then committed. Field names were intentionally left in `snake_case` so API
response keys are unchanged.

## Schema inventory

The baseline covers all 21 application tables:

`users`, `sessions`, `restaurants`, `restaurant_import_jobs`,
`restaurant_members`, `menus`, `menu_items`, `carts`, `orders`, `order_items`,
`payments`, `payment_events`, `simulated_transactions`, `deliveries`,
`driver_assignments`, `state_history`, `outbox`, `notifications`, `reviews`,
`complaints`, `audit_logs`.

Primary keys, unique constraints, foreign keys (including
`payment_events.reference -> payments.reference`), defaults, JSONB columns,
`timestamptz` columns, and the `state_history.sequence` `BIGSERIAL` are all
preserved. Existing IDs (text IDs such as `customer`, `saigon`, `pho`) are
unchanged.

### Objects Prisma cannot express

Prisma's schema language cannot represent PostgreSQL **CHECK constraints** or
**partial indexes**. They live only in the baseline migration SQL,
[`prisma/migrations/20261031000000_baseline/migration.sql`](../prisma/migrations/20261031000000_baseline/migration.sql),
which is the single source of truth for creating a database:

- CHECK constraints (18): role/status enumerations, non-negative prices,
  `total = subtotal + delivery_fee`, rating range, stock and quantity limits.
- Partial indexes (4):
  - `restaurants_osm_identity` unique on `(osm_type, osm_id)` where both exist;
  - `restaurant_import_one_running` unique where `status = 'RUNNING'`;
  - `assignment_active` unique on `delivery_id` where `active = true`;
  - `outbox_pending` on `available_at` where `processed_at IS NULL`.

Any future migration must keep these SQL fragments. Adding them to
`prisma/schema.prisma` is not possible in Prisma 6.

## Modules migrated

| Layer / module                    | Prisma use                                                                |
| --------------------------------- | ------------------------------------------------------------------------- |
| `user.repository.ts`              | `findUnique`, `findFirst`, `create`, `updateMany`, `select`               |
| `session.repository.ts`           | relation filter (`user: { active: true }`), `deleteMany`                  |
| `restaurant.repository.ts`        | search filters, `include` reviews, status updates, row share lock         |
| `menu.repository.ts`              | JSON `options` casts, `upsert` on `(restaurant_id, name)`, stock counters |
| `cart.repository.ts`              | upsert ensure, row lock, JSON casts, optimistic version increment         |
| `order.repository.ts`             | compound idempotency lookup, role relation filters, history BigInt cast   |
| `payment.repository.ts`           | payment/order joins, outbox health counts, simulated upsert               |
| `delivery.repository.ts`          | delivery lookup, assignment updates, creation                             |
| `notification.repository.ts`      | `SKIP LOCKED` claim, `createMany({ skipDuplicates })`, savepoints         |
| `review / complaint / audit`      | `create`, `updateMany`, `findMany`                                        |
| `report.repository.ts`            | `groupBy` order status, daily aggregation in UTC                          |
| `restaurant-import.repository.ts` | job CRUD via Prisma; protected OSM upsert via tagged raw SQL              |
| `server/seed.ts`                  | idempotent `upsert`/`createMany` preserving existing rows                 |
| `server/migrate.ts`               | runs `prisma migrate deploy`; used by tests and the E2E server            |
| `server/app.ts`                   | health `SELECT 1`; `P2002` mapped to HTTP 409                             |
| `server/index.ts`                 | startup ping, session cleanup, `$disconnect()` on shutdown                |

## Intentional raw SQL exceptions

Every raw statement is parameterised or comes from a closed identifier union.
There is no string interpolation of user input.

| Location                                              | Statement                                                                 | Why it stays raw                                                                                                                                                                                              |
| ----------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/db.ts` `lockRow`                              | `SELECT <col> FROM <table> WHERE <col> = $1 FOR UPDATE/SHARE`             | Prisma has no row-lock API. Table and column come from a closed TypeScript union; value is a bind parameter.                                                                                                  |
| `server/order.repository.ts` `advisoryCheckoutLock`   | `pg_advisory_xact_lock(hashtextextended($1, 0))`                          | Serialises concurrent checkouts sharing a customer/idempotency key.                                                                                                                                           |
| `server/notification.repository.ts` `claimEvents`     | `SELECT ... FOR UPDATE SKIP LOCKED`                                       | Outbox claim with non-blocking skip semantics; Prisma has no equivalent.                                                                                                                                      |
| `server/notification.repository.ts` `deliverEvent`    | `SAVEPOINT` / `ROLLBACK TO` / `RELEASE`                                   | Per-notification isolation inside one transaction. Prisma has no savepoint API.                                                                                                                               |
| `server/services/restaurant-import.service.ts`        | `SAVEPOINT import_record`                                                 | One bad OSM record must not roll back the whole batch.                                                                                                                                                        |
| `server/repositories/restaurant-import.repository.ts` | `INSERT ... ON CONFLICT ... DO UPDATE ... WHERE ... RETURNING (xmax = 0)` | Atomic protected upsert: never overwrites verified or owner-managed rows, and reports insert-vs-update. Prisma's `upsert` cannot express the `WHERE` guard or `xmax`.                                         |
| `server/db.ts` `dbNow`                                | `SELECT now()`                                                            | Due-window predicates must use the database clock. The Docker database can be several hundred milliseconds ahead of the host, which otherwise makes `next_reconcile_at = now()` rows invisible to the worker. |
| `server/app.ts`, `server/index.ts`                    | `SELECT 1`                                                                | Health/startup connectivity check.                                                                                                                                                                            |

Notes:

- `pg_advisory_xact_lock` returns `void`; Prisma cannot deserialise a `void`
  column, so these calls use `$executeRaw`/`$executeRawUnsafe`.
- `state_history.sequence` is a `BigInt` in Prisma. History responses convert it
  to a string so `JSON.stringify` cannot fail.

## Transactions and concurrency

- **Interactive transactions**: `transaction(fn)` uses
  `$transaction(fn, { maxWait: 10000, timeout: 20000 })`. Services pass only the
  supplied `db` client to repositories.
- **Row locks**: checkout locks cart/menu/order rows with `FOR UPDATE`; catalog
  reads that must not race with status changes use `FOR SHARE`.
- **Partial unique indexes** still enforce one running import, one active
  assignment per delivery, one OSM identity, and the outbox claim order.
- **Idempotency**: `orders(customer_id, idempotency_key)` unique index plus the
  advisory checkout lock; `payments.order_id/reference` unique;
  `payment_events.event_id` primary key.
- **Outbox**: `FOR UPDATE SKIP LOCKED` claims a batch, then each notification is
  attempted inside a savepoint.
- **OSM import**: one transaction per batch, one savepoint per record, and the
  protected `ON CONFLICT ... WHERE` upsert for existing OSM rows.
- **Foreign keys** remain `NO ACTION` (the previous behaviour); no cascade was
  introduced by introspection.

## Migration and data safety

The existing development database was **not** reset, truncated, pushed, or
seeded over during this work. It was backed up, its schema was compared
programmatically with the baseline, and the baseline was marked as already
applied without executing its DDL.

Prisma Migrate is now the only schema-change path:

- `npm run db:migrate` runs `prisma migrate deploy`. The Docker entrypoint runs
  it before the API and aborts startup if it fails.
- `server/migrate.ts` is a programmatic wrapper around the same `deploy`
  command for integration tests and the E2E server.
- `server/schema.sql` was the old idempotent runtime bootstrap. It is no longer
  used and has been removed; the baseline migration replaces it.
- Startup never seeds. `npm run db:seed` remains the explicit, idempotent seed
  command.
- `prisma db push` and `prisma migrate reset` are never used against an
  existing database.

### Baseline adoption record (2026-10-31)

Target: the Compose development database `food_delivery` on
`127.0.0.1:5433` (service `db`). No credentials are recorded here.

1. **Backup**:
   `backups/pre-prisma-adoption-20261031-170346.dump` (46,736 bytes, custom
   format). `pg_restore --list` exited 0 with 127 TOC entries. The archive was
   restored into the disposable database `restore_check_20261031170405`, which
   contained 21 tables, 18 CHECK constraints, all 4 partial indexes, 6 users,
   3 restaurants, and 1 order. That database was then dropped.
2. **Baseline comparison**: the baseline SQL was applied to a disposable
   database and both databases were introspected for tables, columns (types,
   defaults, nullability), constraints, indexes (including predicates), and
   sequences. After correcting the baseline's `orders_check` name,
   `timestamptz` precision, `now()` defaults, and unique constraints, the
   comparison reported: 21 tables, 158 columns, 74 constraints, 40 indexes,
   1 sequence, **0 differences**.
3. **Resolution**:
   `npx prisma migrate resolve --applied 20261031000000_baseline` updated only
   `_prisma_migrations`. `npx prisma migrate status` then reported
   `Database schema is up to date!`.
4. **Fresh database check**: `prisma migrate deploy` on an empty database
   created 22 tables (21 application tables plus `_prisma_migrations`),
   18 CHECK constraints, and 4 partial indexes. An explicit seed created
   6 users, 3 restaurants, and 8 menu items; `migrate status` reported no
   pending migrations. The database was dropped.
5. **Isolated-schema check**: `prisma migrate deploy` with `?schema=test_...`
   created all 22 tables in that schema and none in `public`, confirming the
   test and E2E bootstrap path. The database was dropped.

Rollback, if ever needed, is a restore of the verified backup above. The
baseline adoption performed no DDL, so no schema rollback is required.

### Creating a future migration

1. Edit `prisma/schema.prisma`.
2. Generate the SQL without applying it:
   `npx prisma migrate dev --create-only --name <description>`.
3. Review the generated SQL. Add or update CHECK constraints and partial
   indexes by hand; Prisma will not generate them.
4. Commit the migration directory.
5. Apply it with `npm run db:migrate` (`prisma migrate deploy`) and confirm with
   `npx prisma migrate status`.

Never use `prisma migrate reset` (it drops all data) or `prisma db push` (it
cannot preserve CHECK constraints or partial indexes) on a database with data.

## Developer commands

```powershell
npm.cmd run db:generate   # regenerate the client after schema edits
npm.cmd run db:validate   # validate prisma/schema.prisma
npm.cmd run db:pull       # re-introspect (read-only; review the diff carefully)
npm.cmd run db:studio     # Prisma Studio at http://localhost:5555
npm.cmd run db:migrate    # apply pending migrations (prisma migrate deploy)
npm.cmd exec prisma migrate status   # show applied and pending migrations
npm.cmd run db:seed       # demo data; requires DEMO_MODE=true
```

`prisma studio` opens a read/write browser UI. Treat it as an administrative
tool: do not use it to edit production data, and never point it at a database
whose credentials you would not put in a browser session.

Tests and the E2E server isolate themselves in unique schemas and bootstrap
them through `prisma migrate deploy` (via `server/migrate.ts`). Because Prisma
reads the `schema` URL parameter while libpq-based `pg` pools read `options`,
the test URLs set both:

```ts
url.searchParams.set('options', `-c search_path=${schema}`);
url.searchParams.set('schema', schema);
```

`pg` remains a **devDependency** for test schema creation/teardown and the E2E
scripts. No application code imports `pg`.

## Verification

| Check                   | Result                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `npx tsc --noEmit`      | Passed                                                                                                                    |
| `npm run build`         | Passed (`prisma generate`, TypeScript, Vite)                                                                              |
| `npm test`              | 34/34 passed (14 architecture + 13 restaurant import + 7 runtime API smoke)                                               |
| `npm run test:e2e`      | 3/3 Playwright Chrome scenarios passed                                                                                    |
| `npm run test:load`     | 200 requests, concurrency 20, 0 errors, p95 103 ms, p99 157 ms                                                            |
| `npm run check:openapi` | 42/42 registered operations documented                                                                                    |
| Docker image rebuild    | Build passed; container healthy; `db:migrate` and `/api/health` OK                                                        |
| Backup and restore      | 46,736-byte dump verified (127 TOC entries); restored to disposable DB with 21 tables, 18 checks, 4 partials, data intact |
| Baseline comparison     | 21 tables, 158 columns, 74 constraints, 40 indexes, 1 sequence, 0 differences                                             |
| Baseline resolution     | `migrate resolve --applied` updated history only; `migrate status` reports up to date                                     |
| Fresh database deploy   | 22 tables (incl. `_prisma_migrations`), 18 checks, 4 partials; explicit seed 6 users / 3 restaurants / 8 items            |
| Isolated-schema deploy  | 22 tables in `test_*` schema, 0 in `public`; `_prisma_migrations` present                                                 |
| Live schema inspection  | 21 tables, 18 CHECK constraints, all 4 partial indexes present; demo data intact (3 restaurants, 6 users, 1 order)        |

## Known limitations

- Prisma cannot model CHECK constraints or partial indexes; they must be
  maintained in SQL.
- `restaurant_import_jobs.status` and other status columns are `String` in
  Prisma rather than enums, because the live database uses `text` with CHECK
  constraints. Converting them to Prisma enums would generate DDL and is out of
  scope.
- `prisma migrate dev` is used only with `--create-only` to author SQL; applying
  migrations to shared databases is done with `prisma migrate deploy`.
- Server-side Prisma query logging is opt-in through `PRISMA_LOG=query`.
- The repository layer still contains the documented raw SQL listed above; this
  is deliberate, not unfinished migration work.

## Files changed

- New: `prisma/schema.prisma`, `prisma/migrations/20261031000000_baseline/`,
  `prisma/migrations/migration_lock.toml`, `docs/PRISMA.md`.
- Rewritten: `server/db.ts`, `server/migrate.ts`, `server/seed.ts`, all
  `server/repositories/*.ts`.
- Adjusted: `server/app.ts`, `server/index.ts`,
  `server/services/restaurant-import.service.ts`, `tests/architecture.test.ts`,
  `tests/restaurant-import.test.ts`, `scripts/e2e-server.ts`,
  `scripts/import-restaurants.ts`, `package.json`.
- Prisma Migrate adoption: `package.json` (`db:migrate` → `prisma migrate
deploy`), `docker-entrypoint.sh`, `Dockerfile` (copies `prisma/` into the
  runtime image), `server/migrate.ts`, and removal of the unused
  `server/schema.sql` runtime bootstrap.
- Documentation: `README.md`, `docs/OPERATIONS.md`, this file.
