# Bếp food delivery

A runnable Phase 1 food delivery application based on **Phase_1_Food_Delivery.docx**. React and TypeScript provide the customer, restaurant, driver, and admin interfaces. An Express modular monolith and PostgreSQL (accessed through Prisma Client) handle the transactions. The original DOCX and its existing Markdown companion are preserved.

The specification is preliminary. This implementation makes explicit, reversible policy choices; it does **not** claim that the document settles payment-provider contracts, cancellation policy, load targets, or disaster recovery objectives. See [implementation decisions](docs/DECISIONS.md).

## Run locally

Requires Node.js 22 or newer and Docker Desktop running Linux containers, or PostgreSQL 17. The browser tests use installed Google Chrome.

```powershell
npm ci
Copy-Item .env.example .env
docker compose up -d db
npm run db:migrate
npm run db:seed
npm run db:seed:mock
npm run dev
```

Open **http://127.0.0.1:5173**. The API listens on port 3001 and the database on localhost:5433. On macOS/Linux use `npm` and `cp .env.example .env` instead. If `.env` already exists, keep your settings rather than copying over it.

The Compose credentials and example password are only local development defaults. Configure your own `DATABASE_URL`, `PAYMENT_WEBHOOK_SECRET` (at least 32 characters), and `DEMO_PASSWORD` in `.env`. Seeding requires `DEMO_MODE=true` and preserves existing records; changing `DEMO_PASSWORD` does not reset previously seeded passwords.

### Run the whole stack in Docker

```powershell
docker compose up --build -d
docker compose run --rm app npm run db:seed
docker compose run --rm app npm run db:seed:mock
```

Compose builds the multi-stage `Dockerfile`, waits for the database healthcheck, then the entrypoint applies pending Prisma migrations (`prisma migrate deploy`) before starting the API on port 3001. A migration failure aborts startup. Seeding stays a deliberate manual step. Open [http://127.0.0.1:3001](http://127.0.0.1:3001); the interactive API reference is at [/api/docs](http://127.0.0.1:3001/api/docs).

| Account           | Email                 | Access                                                          |
| ----------------- | --------------------- | --------------------------------------------------------------- |
| Customer          | customer@bep.local    | Discover, order, pay, track, review, request support            |
| Restaurant        | restaurant@bep.local  | Bếp Phố Hà Thành and other demo kitchens                        |
| Second restaurant | restaurant2@bep.local | Tiệm Pizza Mộc and other demo kitchens                          |
| Driver            | driver@bep.local      | Assigned deliveries                                             |
| Second driver     | driver2@bep.local     | Assignment isolation and reassignment                           |
| Admin             | admin@bep.local       | Approvals, assignments, accounts, complaints, moderation, audit |

All seeded accounts use `DEMO_PASSWORD`; the example value is `LocalDemo123!`. New customers and restaurant owners can register. Driver registration requires admin activation. Public registration cannot create administrators.

To serve the built UI from the API, run `npm run build` then `npm start`, and open **http://127.0.0.1:3001**. Stop the development API first to free port 3001. Local assets and fonts require no third-party browser requests.

### Fictional demo catalog (Hanoi)

The public catalog is a fixed dataset of **10 Hanoi restaurants and 60 dishes**,
seeded by `npm run db:seed:mock`. It requires no API key and makes no
external request. The rows live in PostgreSQL and are served by the normal
catalog API like any other restaurant; names, addresses, phone numbers, opening
hours, prices, ratings and review counts are invented for development.

The seed is idempotent and only upserts its own stable IDs
(`mock-restaurant-01`…`mock-restaurant-10`, `mock-item-001`…`mock-item-060`).
It never overwrites edits to an existing mock row, never deletes anything, and
hides legacy OSM/demo rows by setting `catalog_visible = false`. Orders, order
items, payments, users, carts and reviews are untouched. The seed is a manual
step; it does not run at application startup.

The 10 covers and 60 dish photos are referenced at deterministic paths under
`public/images/restaurants/` and `public/images/menu-items/`. **No raster image
files ship with this workspace yet** because no image-generation tooling is
available here. The UI shows a neutral "Ảnh đang cập nhật" placeholder instead
of an SVG or a stock photo. The complete per-dish prompt list, file names and
suggested sizes are in [docs/MOCK_IMAGE_PROMPTS.md](docs/MOCK_IMAGE_PROMPTS.md);
regenerate it with `npm run assets:prompts`.

```powershell
npm run db:seed:mock   # add/refresh the fictional catalog, hide legacy rows
npm run assets:prompts # write docs/MOCK_IMAGE_PROMPTS.md from the same data
```

### Delivery address, walking routes and shipping fees

A signed-in customer can save one default delivery address in **Account →
Delivery address**: search a Vietnamese address, choose or drag a pin on the
Leaflet/OpenStreetMap map, or optionally use the browser's location permission.
The browser never requires GPS: searching or picking a point works without it.
Saving stores the typed address, the formatted address, coordinates, and
`is_default`. Provider failures leave the previous address unchanged.

The backend geocodes with an adapter (Photon by default, Nominatim supported)
and computes walking routes with Valhalla `costing=pedestrian`. It never uses
straight-line distance as a walking distance. Restaurant coordinates already in
the database are reused; a missing location is geocoded once and persisted only
after success. Restaurant address edits clear the old coordinates so the next
request resolves the new address, without overwriting the address itself.

Delivery fee (backend-only, configurable through `SHIPPING_*`):

- 0–2 km: 10,000 VND
- each started kilometre above 2 km: +3,000 VND
- over 15 km or no pedestrian route: unsupported
- route provider failure: unavailable; checkout is blocked rather than charging 0

The catalog and restaurant detail expose `deliveryInfo` (`distanceMeters`,
`durationSeconds`, `shippingFee`, `supported`, status and, on detail, the route
geometry). With a saved address the default catalog order becomes nearest-first
and unsupported restaurants remain visible last. Without an address the catalog
still loads and prompts the customer to set one; no distance or fee is invented.
Checkout uses the saved address, recomputes the route and fee, and snapshots the
address, coordinates, walking distance and fee on the order. The client-supplied
shipping fee is never trusted; historical orders keep their original snapshot.

The public Photon and Valhalla endpoints are suitable for development and demos,
not as unmonitored production dependencies. Their base URLs, timeouts, caching,
request rate and concurrency are configurable (see `.env.example`); self-host or
use a contracted provider for production. Nominatim was unreachable from this
workspace during verification, so Photon is the default. Map tiles come from
OpenStreetMap and keep the required attribution; configure
`VITE_MAP_TILE_URL`/`VITE_MAP_TILE_ATTRIBUTION` if you use another tile service.

```powershell
npm run db:migrate   # applies the additive address/order-snapshot migration
```

### Legacy OpenStreetMap/demo data

The earlier OSM importer and curated Hanoi demo remain in the database for
development and are hidden from the public catalog by the mock seed. They are
never deleted, so historical orders keep working. `npm run catalog:archive`
reports or re-applies the reversible visibility change; see
[the import guide](docs/IMPORT.md) and [the Hanoi data guide](docs/DATA_IMPORT.md).
Data is © OpenStreetMap contributors (ODbL). The public catalog does not use it.

### Database and Prisma

Prisma Client is the only database access layer in the server. The schema is
committed at `prisma/schema.prisma`; it was introspected from the live database
and keeps the existing `snake_case` names, text IDs, constraints and indexes.

```powershell
npm run db:generate   # regenerate the client after a schema change
npm run db:validate   # validate prisma/schema.prisma
npm run db:studio     # browse data in Prisma Studio (port 5555)
npm run db:migrate    # apply pending migrations (prisma migrate deploy)
npm run db:seed       # demo data; requires DEMO_MODE=true
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

1. Sign in as a customer, save a delivery address under **Account → Delivery address** (or enter one during checkout if none is saved), open a kitchen, add dishes and extras.
2. The catalog and restaurant detail show walking distance, time and the backend shipping fee for that address.
3. Place the order and choose **Simulate successful payment**. No money is charged.
4. In another browser profile, sign in as the restaurant and move the order through Accepted, Preparing, and Ready for pickup.
5. As admin, open Orders and assign an active driver.
6. As that driver, confirm Picked up, In transit, then Delivered.
7. The customer can now leave one review and submit a support request. The admin can resolve support requests and moderate reviews.

The UI refreshes status every seven seconds. Using separate browser profiles or private contexts is necessary to retain multiple account sessions at once.

## Verification

```powershell
npm run build
npm test
npm run test:e2e
npm run test:load
npm run check:openapi
npm run format:check
```

- `build`: regenerates the Prisma client, runs strict TypeScript checking and the optimized Vite build.
- `check:openapi`: fails when a registered route is missing from `openapi.yaml` or the spec documents a route that no router serves.
- `test`: 73 scenarios: 5 static module-boundary checks (public-API-only imports, pure `domain/` code, an acyclic module graph, table ownership; no database needed) and 68 against real PostgreSQL: 14 lifecycle/concurrency scenarios (concurrent last-serving checkout, same-key retry, payload conflicts, atomic rollback, authoritative pricing, invalid transitions, ownership, signed callbacks, late payments, timeout recovery, expiry, refunds, complaints, review eligibility, outbox idempotency), 12 delivery scenarios (fee boundaries 1.2/2/2.1/3/5/8/10/15/>15 km, no-address behavior, address validation and geocoding not-found/timeout, nearest-first pedestrian catalog, per-restaurant routing failure isolation, shipping quote, checkout recompute/ignore client fee/snapshot/address change, historical orders unchanged, missing restaurant coordinates never overwritten, restaurant address change re-geocoding), 13 restaurant-import scenarios (Overpass retries, normalization, protected upserts, dry runs, savepoint isolation, admin job history), 6 pure Hanoi-menu scenarios, 7 Hanoi import/API scenarios, 9 fictional-catalog scenarios (exactly 10 visible restaurants, 60 dishes, 5–8 per restaurant, valid VND prices, hidden-but-retained legacy rows, no provider fields or provider calls in the public catalog path, idempotent seed that preserves edits, preserved order history, no orphan items, raster assets or an explicit skip), and 7 runtime API smoke scenarios (health/docs, auth/session/CSRF, discovery/menu/sorting, cart, checkout→payment→delivery→review, admin/operations, error contract).
- `test:e2e`: five Chrome browser scenarios covering responsive discovery, keyboard dialogs and accessibility checks, the full four-role delivery journey with review and complaint, persistent menu editing, and a saved delivery address driving card/detail walking distance, fee and an address change. Screenshots/traces are written under `test-results/`. The suite seeds the fictional catalog and injects deterministic geocoding/pedestrian-routing adapters, so no public provider is exercised.
- `test:load`: a read-only browse smoke test; the API must already be running. Default: 200 requests, 20 concurrent. Override `LOAD_BASE_URL`, `LOAD_REQUESTS`, or `LOAD_CONCURRENCY`.
- `format:check`: Prettier check over source, tests, scripts and docs. `.prettierrc.json` uses `endOfLine: "auto"` so the check is stable with both LF and CRLF checkouts.

CI is defined in [`.github/workflows/ci.yml`](.github/workflows/ci.yml). It runs `npm ci`, Prisma generate/validate, TypeScript, the production build, OpenAPI coverage, formatting, Compose validation and the full test suite against a disposable PostgreSQL 17 service container. It uses CI-only placeholder credentials and no production data.

Integration and browser tests create and drop uniquely named schemas. They never truncate the development application's tables. Use `TEST_DATABASE_URL` to run them against a separate test database; its user needs schema creation permission. A hard termination can leave a test schema behind. Chrome can be replaced with Playwright Chromium by removing `channel: 'chrome'` in `playwright.config.ts` and installing its browser.

## Code map

```text
src/
  App.tsx                 Application navigation, data loading, basket and checkout
  components/             Account, catalog, orders, workspace, DeliveryAddress map and settings
  api.ts                  HTTP client and money/status formatting
  styles.css              Responsive design tokens and layout
server/
  app.ts                  HTTP middleware, security, module router mounts, error handling, metrics
  index.ts                Server entry point; runs the background worker every 3 seconds
  jobs.ts                 Worker steps: payment reconciliation, unpaid-order expiry,
                          notification delivery, expired-session cleanup
  docs.routes.ts          Swagger UI at /api/docs
  migrate.ts              Runs `prisma migrate deploy` for tests and the E2E server
  seed/                   Demo seed, fictional catalog seed and its data, sample notifications
  shared/                 Shared kernel; never imports a module
    db.ts                 Prisma Client singleton, transaction boundary and row locks
    events.ts             In-process domain events, run inside the publisher's transaction
    errors.ts, types.ts, authz.ts, audit.repository.ts, http/actor.ts
  modules/
    index.ts              Composition root: wires ports and event handlers (registerModules)
    identity/             Accounts, sessions, /auth routes, authentication middleware
    catalog/              Restaurants, menus, stock, approval, restaurant coordinates
      import/             OpenStreetMap/Overpass import and the curated Hanoi dataset
    location/             Saved addresses, geocoding (Photon/Nominatim), walking routes
                          (Valhalla) and the shipping-fee formula
    ordering/             Basket, quote, checkout, order lifecycle, simulated-payment action
    payment/              Payments, signed webhook, provider adapter, reconciliation
    delivery/             Driver assignment and delivery transitions
    notification/         Outbox, inbox and notification delivery
    review/               Reviews and moderation
    support/              Complaints and their resolution
    backoffice/           Admin overview, account status, reports
prisma/
  schema.prisma           Introspected schema preserving existing names and IDs
  migrations/             Baseline SQL, including CHECKs and partial indexes
openapi.yaml              OpenAPI 3.1 contract served at /api/docs
Dockerfile                Multi-stage build; runtime includes tsx for `npm start`
docker-entrypoint.sh      Applies pending migrations, then starts the API
tests/                    PostgreSQL integration and browser tests
docs/                     API contract, decisions, requirement coverage and operations
```

The server is a modular monolith. Each module exposes its public API in `index.ts`; larger modules split into `application/` (use cases and transactions), `domain/` (pure rules) and `infrastructure/` (Prisma queries and provider clients), while small modules stay flat. Modules import each other only through `index.ts`, the module graph has no cycles, and each module touches only its own tables. Payment and Delivery never import Ordering: they read orders through ports they declare, and report outcomes as domain events that Ordering handles inside the same transaction. Read-only cross-module queries live in `*.projection.ts` files. `tests/module-boundaries.test.ts` enforces these rules; [the decision log](docs/DECISIONS.md#module-boundaries) explains them.

## Integration boundaries

**Payment is a simulator**, backed by PostgreSQL so retries and process restarts are meaningful. A generic HMAC callback endpoint is implemented, but is not an integration with a commercial gateway. Production startup rejects simulated payments and demo mode. Implement and validate a real provider adapter and provider-specific callback authentication before enabling real charges.

Delivery distance and fee come from a pedestrian route between the customer's saved address and the restaurant. A customer without a saved address can still browse; checkout then requires a manual address and uses the restaurant's legacy fixed fee. Geocoding, routing, map tiles and the resulting fee are development defaults, not production service contracts. Live GPS tracking, route optimization and capacity scheduling are still not implemented.

See [API reference](docs/API.md), [requirement coverage](docs/COVERAGE.md), [the mock image guide](docs/MOCK_IMAGE_PROMPTS.md), and [operations guide](docs/OPERATIONS.md). The UI uses guidance from the requested [UI UX Pro Max skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill); design choices are recorded in [the design system](design-system/bep/MASTER.md).
