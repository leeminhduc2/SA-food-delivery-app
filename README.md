# Bếp food delivery

A runnable Phase 1 food delivery application based on **Phase_1_Food_Delivery.docx**. React and TypeScript provide the customer, restaurant, driver, and admin interfaces. An Express modular monolith and PostgreSQL handle the transactions. The original DOCX and its existing Markdown companion are preserved.

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

Open **http://127.0.0.1:5173**. The API listens on port 3001 and the database on localhost:55432. On macOS/Linux use `npm` and `cp .env.example .env` instead. If `.env` already exists, keep your settings rather than copying over it.

The Compose credentials and example password are only local development defaults. Configure your own `DATABASE_URL`, `PAYMENT_WEBHOOK_SECRET` (at least 32 characters), and `DEMO_PASSWORD` in `.env`. Seeding requires `DEMO_MODE=true` and preserves existing records; changing `DEMO_PASSWORD` does not reset previously seeded passwords.

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
```

- `build`: strict TypeScript checking and optimized Vite build.
- `test`: 14 integration scenarios against real PostgreSQL, including concurrent last-serving checkout, concurrent same-key retry, payload conflicts, atomic rollback, authoritative pricing, invalid transitions, ownership, signed callbacks, late payments, timeout recovery, expiry, refunds, complaints, review eligibility, and outbox idempotency.
- `test:e2e`: three Chrome browser scenarios covering responsive discovery, keyboard dialogs, accessibility checks, the full four-role delivery journey, and persistent menu editing. Screenshots/traces are written under `test-results/`.
- `test:load`: a read-only browse smoke test; the API must already be running. Default: 200 requests, 20 concurrent. Override `LOAD_BASE_URL`, `LOAD_REQUESTS`, or `LOAD_CONCURRENCY`.

Integration and browser tests create and drop uniquely named schemas. They never truncate the development application's tables. Use `TEST_DATABASE_URL` to run them against a separate test database; its user needs schema creation permission. A hard termination can leave a test schema behind. Chrome can be replaced with Playwright Chromium by removing `channel: 'chrome'` in `playwright.config.ts` and installing its browser.

## Code map

```text
src/
  App.tsx                 Application navigation, data loading, basket and checkout
  components/             Account, catalog, orders, workspace, accessible primitives
  api.ts                  HTTP client and money/status formatting
  styles.css              Responsive design tokens and layout
server/
  app.ts                  HTTP middleware, security, routing, error handling, metrics
  core.ts                 Validation, authorization helpers, audit/history/outbox contracts
  db.ts                   PostgreSQL connection and transaction boundary
  schema.sql              Repeatable initial schema, indexes and additive changes
  modules/
    identity.ts           Scrypt passwords, database sessions, profiles
    catalog.ts            Restaurant membership, menus, pricing, inventory
    orders.ts             Cart, checkout, idempotency, order lifecycle
    payments.ts           Provider adapter, signatures, reconciliation and refunds
    delivery.ts           Driver assignments and delivery lifecycle
    operations.ts         Reviews, complaints, notifications, reporting, admin
  index.ts                Server and durable-work polling loop
tests/                    PostgreSQL integration and browser tests
docs/                     API contract, decisions, requirement coverage and operations
```

## Integration boundaries

**Payment is a simulator**, backed by PostgreSQL so retries and process restarts are meaningful. A generic HMAC callback endpoint is implemented, but is not an integration with a commercial gateway. Production startup rejects simulated payments and demo mode. Implement and validate a real provider adapter and provider-specific callback authentication before enabling real charges.

Delivery uses a trusted fixed fee and indicative ETA configured per restaurant. Addresses are free text. There is no geocoding, live GPS tracking, route optimization, or service-area verification. Notifications are delivered to the app inbox through a transactional outbox; email/SMS/push are not connected.

See [API reference](docs/API.md), [requirement coverage](docs/COVERAGE.md), and [operations guide](docs/OPERATIONS.md). The UI uses guidance from the requested [UI UX Pro Max skill](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill); design choices are recorded in [the design system](design-system/bep/MASTER.md).
