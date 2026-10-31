# Bếp food delivery

A runnable Phase 1 food delivery application based on **Phase_1_Food_Delivery.docx**. React and TypeScript provide the customer, restaurant, driver, and admin interfaces. An Express modular monolith and PostgreSQL (accessed through Prisma Client) handle the transactions. The original DOCX and its existing Markdown companion are preserved.

The specification is preliminary. This implementation makes explicit, reversible policy choices; it does **not** claim that the document settles payment-provider contracts, cancellation policy, load targets, or disaster recovery objectives. See [implementation decisions](docs/DECISIONS.md).

## Run locally

Requires Node.js 22 or newer and Docker Desktop running Linux containers, or PostgreSQL 17. The browser tests use installed Google Chrome.

```powershell
npm.cmd ci
Copy-Item .env.example .env
docker compose up -d db
npm.cmd run db:migrate
npm.cmd run db:seed
npm.cmd run dev
```

Open **http://127.0.0.1:5173**. The API listens on port 3001 and the database on localhost:5433. On macOS/Linux use `npm` and `cp .env.example .env` instead. If `.env` already exists, keep your settings rather than copying over it.

The Compose credentials and example password are only local development defaults. Configure your own `DATABASE_URL`, `PAYMENT_WEBHOOK_SECRET` (at least 32 characters), and `DEMO_PASSWORD` in `.env`. Seeding requires `DEMO_MODE=true` and preserves existing records; changing `DEMO_PASSWORD` does not reset previously seeded passwords.

### Run the whole stack in Docker

```powershell
docker compose up --build -d
docker compose run --rm app npm run db:seed
```

Compose builds the multi-stage `Dockerfile`, waits for the database healthcheck, then the entrypoint applies pending Prisma migrations (`prisma migrate deploy`) before starting the API on port 3001. A migration failure aborts startup. Seeding stays a deliberate manual step. Open [http://127.0.0.1:3001](http://127.0.0.1:3001); the interactive API reference is at [/api/docs](http://127.0.0.1:3001/api/docs).

| Account           | Email                 | Access                                                          |
| ----------------- | --------------------- | --------------------------------------------------------------- |
| Customer          | customer@bep.local    | Discover, order, pay, track, review, request support            |
| Restaurant        | restaurant@bep.local  | Bếp Nhà Sài Gòn menu and orders                                 |
| Second restaurant | restaurant2@bep.local | Little Italy Kitchen and The Green Table                        |
| Driver            | driver@bep.local      | Assigned deliveries                                             |
| Second driver     | driver2@bep.local     | Assignment isolation and reassignment                           |
| Admin             | admin@bep.local       | Approvals, assignments, accounts, complaints, moderation, audit |

All seeded accounts use `DEMO_PASSWORD`; the example value is `LocalDemo123!`. New customers and restaurant owners can register. Driver registration requires admin activation. Public registration cannot create administrators.

To serve the built UI from the API, run `npm.cmd run build` then `npm.cmd start`, and open **http://127.0.0.1:3001**. Stop the development API first to free port 3001. Local assets and fonts require no third-party browser requests.

### Restaurant data from OpenStreetMap

Restaurants can be imported from the Overpass API as unverified, non-orderable
records. Existing manual, verified, or owner-managed rows are never overwritten.

```powershell
npm.cmd run import:restaurants -- --dry-run
npm.cmd run import:restaurants
```

Administrators can also queue an import with `POST /api/admin/restaurants/import`
and read job history at `GET /api/admin/restaurants/import/history`. Data is ©
OpenStreetMap contributors and licensed under the ODbL; see
[the import guide](docs/IMPORT.md) for configuration, limits, and attribution.

### Database and Prisma

Prisma Client is the only database access layer in the server. The schema is
committed at `prisma/schema.prisma`; it was introspected from the live database
and keeps the existing `snake_case` names, text IDs, constraints and indexes.

```powershell
npm.cmd run db:generate   # regenerate the client after a schema change
npm.cmd run db:validate   # validate prisma/schema.prisma
npm.cmd run db:studio     # browse data in Prisma Studio (port 5555)
npm.cmd run db:migrate    # apply pending migrations (prisma migrate deploy)
npm.cmd run db:seed       # demo data; requires DEMO_MODE=true
```

Prisma cannot express PostgreSQL CHECK constraints or partial indexes; those
live in the baseline migration SQL under `prisma/migrations/`. The existing
development database was backed up, compared with the baseline, and marked as
already migrated, so `db:migrate` only applies genuinely new migrations. Create
future migrations with `prisma migrate dev --create-only`, review and extend
the SQL when CHECKs or partial indexes change, commit it, then apply with
`prisma migrate deploy`. Never run `prisma migrate reset` or `prisma db push`
against an existing database. See [the Prisma notes](docs/PRISMA.md) for the
adoption record, backup details, and fresh-database verification.

## Try a complete order

1. Sign in as a customer, open a kitchen, add dishes and extras, and enter a delivery address.
2. Place the order and choose **Simulate successful payment**. No money is charged.
3. In another browser profile, sign in as the restaurant and move the order through Accepted, Preparing, and Ready for pickup.
4. As admin, open Orders and assign an active driver.
5. As that driver, confirm Picked up, In transit, then Delivered.
6. The customer can now leave one review and submit a support request. The admin can resolve support requests and moderate reviews.

The UI refreshes status every seven seconds. Using separate browser profiles or private contexts is necessary to retain multiple account sessions at once.

## Verification

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:e2e
npm.cmd run test:load
npm.cmd run check:openapi
npm.cmd run format:check
```

- `build`: regenerates the Prisma client, runs strict TypeScript checking and the optimized Vite build.
- `check:openapi`: fails when a registered route is missing from `openapi.yaml` or the spec documents a route that no router serves.
- `test`: 34 scenarios against real PostgreSQL: 14 lifecycle/concurrency scenarios (concurrent last-serving checkout, same-key retry, payload conflicts, atomic rollback, authoritative pricing, invalid transitions, ownership, signed callbacks, late payments, timeout recovery, expiry, refunds, complaints, review eligibility, outbox idempotency), 13 restaurant-import scenarios (Overpass retries, normalization, protected upserts, dry runs, savepoint isolation, admin job history), and 7 runtime API smoke scenarios (health/docs, auth/session/CSRF, discovery/menu/sorting, cart, checkout→payment→delivery→review, admin/operations, error contract).
- `test:e2e`: three Chrome browser scenarios covering responsive discovery, keyboard dialogs, accessibility checks, the full four-role delivery journey, and persistent menu editing. Screenshots/traces are written under `test-results/`.
- `test:load`: a read-only browse smoke test; the API must already be running. Default: 200 requests, 20 concurrent. Override `LOAD_BASE_URL`, `LOAD_REQUESTS`, or `LOAD_CONCURRENCY`.
- `format:check`: Prettier check over source, tests, scripts and docs. `.prettierrc.json` uses `endOfLine: "auto"` so the check is stable with both LF and CRLF checkouts.

CI is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml). It runs `npm ci`, Prisma generate/validate, TypeScript, the production build, OpenAPI coverage, formatting, Compose validation and the full test suite against a disposable PostgreSQL 17 service container. It uses CI-only placeholder credentials and no production data.

Integration and browser tests create and drop uniquely named schemas. They never truncate the development application's tables. Use `TEST_DATABASE_URL` to run them against a separate test database; its user needs schema creation permission. A hard termination can leave a test schema behind. Chrome can be replaced with Playwright Chromium by removing `channel: 'chrome'` in `playwright.config.ts` and installing its browser.

## Code map

```text
src/
  App.tsx                 Application navigation, data loading, basket and checkout
  components/             Account, catalog, orders, workspace, accessible primitives
  api.ts                  HTTP client and money/status formatting
  styles.css              Responsive design tokens and layout
server/
  app.ts                  HTTP middleware, security, mounts, error handling, metrics
  index.ts                Server entry point and durable-work polling loop
  db.ts                   Prisma Client singleton, transaction boundary and row locks
  migrate.ts              Runs `prisma migrate deploy` for tests and the E2E server
  api/                    HTTP layer: routes, cookies, status codes, validation gates
    identity.routes.ts    /auth
    catalog.routes.ts     Restaurants, menus and dishes
    orders.routes.ts      Basket, quote, checkout and order lifecycle
    payments.routes.ts    Raw-body webhook and simulated payment
    delivery.routes.ts    Driver assignment and delivery transitions
    operations.routes.ts  Reviews, complaints, notifications, reports, admin
    docs.routes.ts        Swagger UI at /api/docs
    middleware/           Session resolution and actor helpers
  services/               Business rules and transactions; no Express, no raw pool
    identity, catalog, cart, order, payment, delivery,
    review, support, notification, report, admin
  repositories/           Prisma Client queries per aggregate; accept a transaction client
  domain/                 Pure types, errors, authorization and Zod schemas
prisma/
  schema.prisma           Introspected schema preserving existing names and IDs
  migrations/             Baseline SQL, including CHECKs and partial indexes
openapi.yaml              OpenAPI 3.1 contract served at /api/docs
Dockerfile                Multi-stage build; runtime includes tsx for `npm start`
docker-entrypoint.sh      Applies pending migrations, then starts the API
tests/                    PostgreSQL integration and browser tests
docs/                     API contract, decisions, requirement coverage and operations
```

## Integration boundaries

**Payment is a simulator**, backed by PostgreSQL so retries and process restarts are meaningful. A generic HMAC callback endpoint is implemented, but is not an integration with a commercial gateway. Production startup rejects simulated payments and demo mode. Implement and validate a real provider adapter and provider-specific callback authentication before enabling real charges.

Delivery uses a trusted fixed fee and indicative ETA configured per restaurant. Addresses are free text. There is no geocoding, live GPS tracking, route optimization, or service-area verification. Notifications are delivered to the app inbox through a transactional outbox; email/SMS/push are not connected.

See [API reference](docs/API.md), [requirement coverage](docs/COVERAGE.md), and [operations guide](docs/OPERATIONS.md). The UI uses guidance from the requested [UI UX Pro Max skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill); design choices are recorded in [the design system](design-system/bep/MASTER.md).
