# OpenStreetMap restaurant import

The importer fetches restaurants for a bounding box from the Overpass API,
normalizes them, and upserts them as **unverified, non-orderable** records.
It never enables ordering, never marks a restaurant verified, and never
overwrites manual, admin-verified, or owner-managed data.

## Sources and licensing

Data © OpenStreetMap contributors, available under the
[Open Database License (ODbL)](https://www.openstreetmap.org/copyright). The UI
footer attributes the source. Keep the attribution if you reuse the data, and
review the ODbL requirements before redistributing derived databases.

Respect the [Overpass API usage policy](https://operations.osmfoundation.org/policies/overpass/):
the importer makes one request at a time, uses a configurable timeout, retries
with backoff, honours `Retry-After`, and caps response size. Do not schedule
frequent large imports. Point `OVERPASS_ENDPOINT` at your own instance for
regular use.

## Configuration

| Variable                | Default                                   | Purpose                                     |
| ----------------------- | ----------------------------------------- | ------------------------------------------- |
| `OVERPASS_ENDPOINT`     | `https://overpass-api.de/api/interpreter` | Interpreter URL (`http`/`https` only)       |
| `OVERPASS_HANOI_BBOX`   | `20.95,105.75,21.1,105.9`                 | Default bounding box: south,west,north,east |
| `OVERPASS_TIMEOUT_MS`   | `30000`                                   | Request timeout                             |
| `OVERPASS_RETRIES`      | `3`                                       | Retry attempts for transient failures/429   |
| `OVERPASS_MAX_ELEMENTS` | `2000`                                    | Reject larger responses                     |
| `IMPORT_BATCH_SIZE`     | `50`                                      | Records per persistence transaction         |

The admin API never accepts an endpoint or URL; the endpoint is server-side
configuration only.

## CLI

```powershell
npm.cmd run import:restaurants -- --dry-run
npm.cmd run import:restaurants
npm.cmd run import:restaurants -- --bbox=20.9,105.7,21.1,105.9 --json
```

Dry runs fetch, validate, deduplicate, and classify records without writing
restaurant rows or job history. A failing batch is isolated by savepoints and
reported; the command exits non-zero only when every attempted write failed.

## Admin API

| Method | Path                                    | Behaviour                                                                                                                                                       |
| ------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST` | `/api/admin/restaurants/import`         | Admin-only; validates the optional `bbox`/`dryRun`, refuses a second running import with `409 IMPORT_IN_PROGRESS`, and returns `202` with a job ID immediately. |
| `GET`  | `/api/admin/restaurants/import/history` | Admin-only; recent jobs with status, timestamps and stats.                                                                                                      |

The job runs in the API process after the response is sent. Status is persisted
in `restaurant_import_jobs`; a partial unique index allows at most one
`RUNNING` job across processes.

## Data rules

- Only `amenity=restaurant|fast_food|food_court` records with a name and valid
  coordinates are accepted.
- Duplicate OSM identities in one response are collapsed; counts are reported.
- New rows get `source='OSM'`, `status='PENDING'`, `verified=false`,
  `owner_managed=false`, `delivery_fee=0`, empty `image`/`description`, and the
  raw tags in `osm_tags`.
- Existing rows are refreshed only when `source='OSM'` **and** both protection
  flags are false. The protected upsert is a documented raw-SQL exception; see
  [PRISMA.md](PRISMA.md).
- Unknown fields are never invented. Missing address/phone are counted in the
  report.

## Verification

`tests/restaurant-import.test.ts` covers Overpass retries and timeouts,
normalization/dedupe, empty and partial responses, protected updates, dry runs,
savepoint isolation, database failures, admin authorization, background jobs,
and source attribution. All Overpass calls are mocked; the suite does not
contact the public API. Tests use an isolated schema and drop it afterwards.
