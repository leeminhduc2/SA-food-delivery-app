# Hanoi data import — execution report

Run date: 2026-10-31 (Asia/Saigon)
Environment: local Docker Compose PostgreSQL 17, development database
`food_delivery`
Tool: `npm run import:hanoi -- --timeout=120000`
Overpass endpoint: `https://overpass-api.de/api/interpreter`

The implementation and operational rules are documented in
[DATA_IMPORT.md](DATA_IMPORT.md). The pre-implementation audit is
[DATA_IMPORT_AUDIT.md](DATA_IMPORT_AUDIT.md).

## Result summary

| Metric                   | Before | After | Delta |
| ------------------------ | -----: | ----: | ----: |
| `restaurants`            |      3 |    33 |   +30 |
| `menus`                  |      3 |    93 |   +90 |
| `menu_items`             |      8 |   308 |  +300 |
| `users`                  |      6 |     6 |     0 |
| `orders`                 |      1 |     1 |     0 |
| `restaurant_import_jobs` |      0 |     4 |    +4 |

All 3 original manual restaurants remain `source='MANUAL'`,
`status='APPROVED'`, `owner_managed=true` with unchanged names, cuisines and
menus. The three external-facing counts are exactly the expected additions:
30 restaurants, 3 demo categories each, and 10 demo items each.

## Import runs

| Job                                    | Status    | Result                                                                              |
| -------------------------------------- | --------- | ----------------------------------------------------------------------------------- |
| `4d7dafd5-f9ce-4ce0-bb84-9b29acb89545` | FAILED    | First attempt: Overpass HTTP 502; no restaurant/menu writes                         |
| `7d46aa58-c42b-449d-a551-46711e454bcd` | FAILED    | Mirror attempt: Overpass request timed out after 30 s; no restaurant/menu writes    |
| `19698771-0650-46de-8bf2-08111f283df6` | SUCCEEDED | Created 30, updated 0, approved 30, 90 menus ensured, 300 items created, 0 failures |
| `f39f7012-9eee-4692-8c7d-0c931ba02f4b` | SUCCEEDED | Created 0, updated 30, approved 30, 90 menus ensured, 0 items created, 0 failures   |

The two failed jobs are retained as history; they wrote no restaurant or menu
rows. The successful runs took 45.2 s and 43.4 s. The public endpoint can exceed
the default 30 s timeout for the combined 30-node query, so `--timeout=120000`
is recommended and documented.

After the second run the counts were unchanged at 33 restaurants, 93 menus and
308 items, proving idempotency against the live database.

## Imported restaurants

All records are OSM nodes. Cuisine is the formatted OSM `cuisine` tag, or
`Unclassified` when OSM does not provide one; no cuisine was inferred from the
name. Every row has an address, coordinates, a local SVG cover, an OSM source
URL, and exactly 10 demo menu items.

| OSM node   | Name                         | Cuisine (OSM)                  | Demo profile  | Items |
| ---------- | ---------------------------- | ------------------------------ | ------------- | ----: |
| 104770283  | Cửa Hàng Bò Nầm Nướng        | Unclassified                   | bbq           |    10 |
| 721788305  | Nhà Hàng Little Hanoi        | Unclassified                   | vietnamese    |    10 |
| 721788307  | Nhà Hàng New Day             | Unclassified                   | vietnamese    |    10 |
| 721836715  | Quán Ăn Ngon - Phan Bội Châu | Vietnamese                     | vietnamese    |    10 |
| 721906714  | Sushi Hokkaido Sachi         | Unclassified                   | japanese      |    10 |
| 721906721  | Tandoor Indian Cuisine       | Unclassified                   | indian        |    10 |
| 723684563  | Nhà Hàng La Badiane          | Unclassified                   | french        |    10 |
| 773601261  | Pho 10                       | Vietnamese                     | vietnamese    |    10 |
| 963611886  | Thai Village                 | Thai                           | thai          |    10 |
| 975757197  | Toshi Fusion                 | Unclassified                   | japanese      |    10 |
| 977647355  | Nhà Hàng Duy Lê Malraux      | Unclassified                   | french        |    10 |
| 993037617  | Nhà Hàng Yakiniku Shiki      | Unclassified                   | bbq           |    10 |
| 998227583  | Nhà Hàng Green Mango         | Unclassified                   | international |    10 |
| 1000087449 | Nhà Hàng Chả Cá Văn Miếu     | Asian                          | vietnamese    |    10 |
| 1671744985 | Nhà Hàng Chả Cá Thủy Hồng    | Vietnamese                     | vietnamese    |    10 |
| 2256217990 | Nhà Hàng Blue Butterfly      | Asian, International           | international |    10 |
| 2256217991 | Nhà Hàng Essence             | Unclassified                   | vietnamese    |    10 |
| 2259067320 | Chả Cá Cà Cuống              | Unclassified                   | vietnamese    |    10 |
| 2587491495 | Phở Cường                    | Vietnamese                     | vietnamese    |    10 |
| 3370369424 | Nhà Hàng Wa Japanese Cuisine | Japanese                       | japanese      |    10 |
| 3496458225 | Nhà Hàng Foodshop 45         | Indian                         | indian        |    10 |
| 3496464405 | Quán Cơm Mậu Dịch            | Vietnamese                     | vietnamese    |    10 |
| 3496893646 | Quan An Ngon                 | Vietnamese                     | vietnamese    |    10 |
| 3514125539 | Bánh Mì 25                   | Sandwich                       | sandwich      |    10 |
| 3671198536 | Nhà Hàng Moto-san            | Japanese                       | japanese      |    10 |
| 3678370944 | The Hanoi Social Club        | Breakfast, Burger, Coffee Shop | cafe          |    10 |
| 4151407589 | Bún Chẳ Đắc Kim              | Vietnamese                     | vietnamese    |    10 |
| 4186819465 | Pho Thin                     | Unclassified                   | vietnamese    |    10 |
| 4210706604 | Xoi Yen                      | Unclassified                   | vietnamese    |    10 |
| 4272727197 | Cửa Hàng Bún Chả Hương Liên  | Deli, Vietnamese, Grill        | vietnamese    |    10 |

## Data completeness

Measured on the 30 imported rows:

| Field                         | Present | Missing / fallback |
| ----------------------------- | ------: | -----------------: |
| Name                          |      30 |                  0 |
| Address                       |      30 |                  0 |
| Coordinates                   |      30 |                  0 |
| Cuisine tag                   |      16 |  14 `Unclassified` |
| Phone                         |       8 |                 22 |
| Website                       |       8 |                 22 |
| Opening hours                 |       8 |                 22 |
| Cover illustration            |      30 |                  0 |
| `_bep` demo metadata          |      30 |                  0 |
| 3 menus / 10 items per record |      30 |                  0 |

Missing OSM fields are reported, not fabricated. `Unclassified` is displayed
as-is; the import never guesses a cuisine from a restaurant name.

## Real data versus demo data

**Real OSM data:** names, addresses (`addr:*`), latitude/longitude, cuisine,
phone, website and opening hours when present. Each row stores
`source='OSM'`, `osm_type`, `osm_id`, `imported_at`, `last_synced_at`,
`address_tags`, the raw tags in `osm_tags`, and `osm_tags._bep.sourceUrl`.

**Demo data:** every menu, dish, description and price, plus all cover and dish
images. `osm_tags._bep.menu` contains `dataType: "DEMO"`, `official: false`,
the selected profile and a notice. `osm_tags._bep.image` records
`type: "ILLUSTRATION"` and the project-asset licence. The UI shows a demo
banner and marks imported cards with "Demo menu".

Imported rows are visible (`APPROVED`) but are **not verified**
(`verified=false`, `owner_managed=false`). The source line in the detail view
states that OpenStreetMap data is unverified by the restaurant.

## Licences and attribution

- OpenStreetMap data: © OpenStreetMap contributors, ODbL 1.0. The UI footer and
  detail source line link to the OSM copyright page; each record stores its own
  source URL and licence marker.
- Images: generated by `scripts/generate-hanoi-images.ts` as project-owned demo
  SVG illustrations. No third-party photograph, Google Images result or remote
  hot-linked image is used. The generator wrote 58 files (28 dish illustrations
  and 30 covers).
- Menu text and prices: original demo content for this project, not copied from
  restaurant menus.

## Safety checks

- No Prisma schema change and no migration were required.
- No `db push`, `migrate reset`, truncate, baseline edit or data deletion was
  run.
- `.env` and secrets were not modified.
- Existing manual restaurants and their menus/items were not touched; the
  protected-upsert predicate reports them as protected and excludes them from
  updates.
- Dry-run wrote no restaurant, menu, item or job rows.
- Re-running the import added 0 restaurants, 0 menus and 0 menu items.
- No test schema remains after the suite (each test drops its
  `test_hanoi_<uuid>`/`e2e_<uuid>` schema).

## Known limitations

- OSM is crowd-sourced: addresses/contacts/hours can be incomplete or outdated
  and have not been verified by the venues.
- 14 of 30 records have no OSM cuisine tag and display `Unclassified`; 22 have
  no phone, website or opening hours.
- Menus and prices are demo data and must not be presented as official.
- The public Overpass endpoint can be slow or return transient 5xx responses;
  the default 30 s timeout may be too short for the 30-node query. Use
  `--timeout=120000` and respect the Overpass usage policy.
- Demo items are orderable through the existing cart/checkout, as required for
  catalog parity; the UI disclosure makes their demo status clear.
- The import does not geocode user addresses or verify delivery coverage.

## Verification commands and results

All commands were run on 2026-10-31 against the development database and the
current workspace.

| Command                         | Result                                                     |
| ------------------------------- | ---------------------------------------------------------- |
| `npx prisma validate`           | Pass — schema valid                                        |
| `npx prisma migrate status`     | Pass — 1 migration, database up to date                    |
| `npx tsc --noEmit`              | Pass — no diagnostics                                      |
| `npm run build`                 | Pass — Prisma client generated, Vite built 1,589 modules   |
| `npm run check:openapi`         | Pass — 42 registered, 42 documented operations             |
| `npm run format:check`          | Pass — all matched files formatted                         |
| `npm test`                      | Pass — 47 tests, 0 failures                                |
| `npm run test:e2e`              | Pass — 4 Chromium scenarios, 0 failures                    |
| `docker compose config --quiet` | Pass — no output                                           |
| Leftover test schemas           | 0 (`test_*` / `e2e_*` query returned no rows)              |
| Final database counts           | 33 restaurants, 93 menus, 308 menu_items, 6 users, 1 order |

The test run includes the existing lifecycle, import, and runtime API smoke
suites, so the new feature did not regress cart, checkout, payment, delivery,
review, admin, or import behavior.
