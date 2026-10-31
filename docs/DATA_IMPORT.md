# Hanoi data import service

The Hanoi import extends the existing OpenStreetMap pipeline described in
[IMPORT.md](IMPORT.md). It does not create a second catalog, a second import
endpoint, or new database tables. Curated restaurant identities come from
OpenStreetMap; contacts, addresses and coordinates are always read from the
live Overpass response and never typed into the repository.

The audit that preceded this work is in
[DATA_IMPORT_AUDIT.md](DATA_IMPORT_AUDIT.md). Actual run results are in
[DATA_IMPORT_REPORT.md](DATA_IMPORT_REPORT.md).

## What is real and what is demo

| Data                         | Source                                                  | Status                                               |
| ---------------------------- | ------------------------------------------------------- | ---------------------------------------------------- |
| Restaurant name              | OSM `name` tag in the live Overpass response            | Real OSM data, displayed as-is                       |
| Address, ward/district/city  | OSM `addr:*` tags, normalised by `normalizeOsmElements` | Real OSM data, unverified                            |
| Latitude / longitude         | OSM element `lat` / `lon`                               | Real OSM data                                        |
| Cuisine, phone, website      | OSM `cuisine`, `phone`/`contact:phone`, `website` tags  | Real OSM data when present; `Unclassified` otherwise |
| Opening hours                | OSM `opening_hours` tag                                 | Real OSM data when present                           |
| Menus, dish names and prices | Curated demo profiles in `server/domain/hanoi.ts`       | **Demo data, not official menus or prices**          |
| Cover and dish images        | Generated local SVG illustrations in `public/images/`   | **Project demo assets, not venue photographs**       |

The database records the distinction in `restaurants.osm_tags._bep`:

```json
{
  "_bep": {
    "schema": 1,
    "dataProvider": "OpenStreetMap",
    "sourceUrl": "https://www.openstreetmap.org/node/<id>",
    "license": "ODbL-1.0",
    "attribution": "© OpenStreetMap contributors",
    "importedBy": "bep-hanoi-demo-import/1.0",
    "menu": {
      "dataType": "DEMO",
      "official": false,
      "profile": "vietnamese",
      "itemCount": 10,
      "notice": "Demo dishes and prices; not the restaurant’s official menu."
    },
    "image": {
      "type": "ILLUSTRATION",
      "license": "Project demo asset",
      "source": "/images/hanoi-<id>.svg",
      "note": "Illustration, not a photograph of the venue."
    }
  }
}
```

Imported rows are `status='APPROVED'` so they are visible in discovery, but
`verified=false` and `owner_managed=false`. The UI adds a demo-menu banner, an
OpenStreetMap source line, and an illustration tooltip.

## Curated selection and demo menus

`server/domain/hanoi.ts` contains 30 real Hanoi OSM node identities. Each entry
also names a menu profile and an `expectedName` used only for drift detection;
the imported name always comes from Overpass.

Nine demo profiles are available: Vietnamese, Japanese, Indian, Thai, French,
International, Café, Grill & BBQ, and Bánh mì & sandwiches. Every profile has
three categories (Starters, Main dishes, Drinks) with 12 candidate dishes.
`buildDemoMenu` takes a deterministic 3/4/3 selection, producing 10 items per
restaurant and 300 items in total for the curated set. Prices are whole VND,
adjusted deterministically per restaurant within the schema's allowed range.
Item IDs are deterministic (`demo-<type>-<id>-<n>`), so re-running the import is
idempotent.

## Images and licensing

All menu and cover images are local, project-owned SVG illustrations generated
by `npm run assets:hanoi` (`scripts/generate-hanoi-images.ts`). No remote image
is hot-linked, no Google Images result is used, and no photograph is presented
as the venue. The `imageSchema` accepts the generated HTTPS-free local paths
(`/images/<name>.svg`). `SmartImage` falls back to
`/images/vietnamese.svg` if an asset is missing or fails to load.

OpenStreetMap data is © OpenStreetMap contributors and available under the
[ODbL](https://www.openstreetmap.org/copyright). The UI keeps the attribution
link, and each imported record stores its own `sourceUrl` and licence marker.
Review ODbL obligations before redistributing a derived database.

## Commands

```powershell
# Preview the live plan without writing restaurant/menu/job rows
npm.cmd run import:hanoi -- --dry-run

# Import all 30 curated records (long timeout recommended on the public endpoint)
npm.cmd run import:hanoi -- --timeout=120000

# Import one curated record
npm.cmd run import:hanoi -- --only=node/3678370944 --timeout=120000

# Regenerate the local SVG illustrations (only needed when profiles change)
npm.cmd run assets:hanoi
```

Flags: `--dry-run`, `--only=<type>/<id>` (repeatable), `--endpoint=<url>`,
`--timeout=<ms>`, `--max-elements=<n>`, `--json`, `--help`.

The import target is configured by `DATABASE_URL` like the rest of the app.
Do not point a destructive or reset command at the development database; this
feature never runs `db push`, `migrate reset`, truncate, or data deletion.

## Safety and idempotency

1. The existing protected upsert (`INSERT ... ON CONFLICT ... WHERE ...`) runs
   first. It refreshes only rows with `source='OSM' AND verified=false AND
owner_managed=false`; manual, verified and owner-managed rows are untouched.
2. A second guarded `UPDATE` adds cuisine/description/image/delivery/ETA and
   merges the `_bep` metadata. The same protection predicate is repeated, so a
   row that became owner-managed between the two statements is skipped.
3. Menus are upserted by `(restaurant_id, name)`. Items are inserted with
   deterministic IDs and `createMany({ skipDuplicates: true })`.
4. Re-running the command leaves row/menu/item counts unchanged. A dry run
   writes no restaurant, menu, item or job rows.
5. Each non-dry run records one row in `restaurant_import_jobs`, including
   counts and failures. Stale `RUNNING` jobs older than 15 minutes are marked
   failed by the next import.

Rows that are verified or owner-managed are reported as `protectedSkipped` and
are never overwritten, including their name, description, contact details and
menu. The import never deletes a row.

## API and frontend

No new endpoint was added. The existing public catalog endpoints already return
the provenance fields and the embedded menu:

- `GET /api/restaurants` — list, search, cuisine filter and sorting.
- `GET /api/restaurants/:id` — detail with `items` and `reviews`.

`openapi.yaml` documents the provenance fields on the `Restaurant` schema.
Coverage checking (`npm run check:openapi`) still sees the same routes.

The React discovery page consumes the API without hardcoded restaurant data:

- card list from `GET /api/restaurants`, with "Demo menu" labels for imported
  records;
- detail hero with address, phone, opening hours, website, OSM source line and
  demo-menu notice;
- menu grouped by the API's `category` field;
- dynamic cuisine chips derived from the returned restaurants;
- lazy-loaded images with a local fallback (`SmartImage`);
- loading, empty and error states retained from the existing catalog.

The existing cart and checkout flow is unchanged: imported demo items are
ordinary `menu_items` and can be ordered exactly like seeded items, with the UI
making clear that the menu is illustrative.

## Tests

- `tests/hanoi-menu.test.ts` — pure tests for the curated list, profile shape,
  deterministic menus/prices, image paths, metadata and cuisine formatting.
- `tests/hanoi-import.test.ts` — isolated-schema integration tests for dry-run,
  missing records, creation, API search/filter/detail, idempotency, protected
  rows and invalid CLI selections.
- `tests/browser/flows.spec.ts` — the E2E fixture server imports two real OSM
  records through the production code path; the browser test covers the demo
  banner, OSM source line, grouped menu, cuisine filter, image fallback and
  responsive width.

All tests use isolated schemas (`test_hanoi_<uuid>`, `e2e_<uuid>`) and drop them
afterwards. They do not contact Overpass; live imports are run manually.
