-- Additive catalog fields for Google Places API (New).
-- Existing rows keep every value; catalog_visible defaults to true so this
-- migration does not hide or delete anything. The legacy image-review tables
-- remain in the database and are intentionally not touched here.

ALTER TABLE "restaurants"
  ADD COLUMN "catalog_visible" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "google_place_id" TEXT,
  ADD COLUMN "google_maps_uri" TEXT,
  ADD COLUMN "google_primary_type" TEXT,
  ADD COLUMN "google_business_status" TEXT,
  ADD COLUMN "photo_name" TEXT,
  ADD COLUMN "photo_attribution" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "photo_verified_food" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "places_synced_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX "restaurants_google_place" ON "restaurants"("google_place_id");
CREATE INDEX "restaurants_catalog_visible" ON "restaurants"("status", "catalog_visible");

-- A Google photo resource name is stored, never a client-supplied URL or a URL
-- containing the API key. The proxy resolves this name server-side.
ALTER TABLE "restaurants"
  ADD CONSTRAINT "restaurants_photo_name_check"
  CHECK (
    "photo_name" IS NULL
    OR "photo_name" ~ '^places/[^/[:space:]]+/photos/[^/[:space:]]+$'
  );
