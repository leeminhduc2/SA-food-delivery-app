-- Additive mock-catalog fields.
--
-- This migration only adds nullable/defaulted columns. It does not drop the
-- Google Places columns from the previous integration, and it does not touch
-- restaurants, menus, menu items, orders or any historical row. Legacy rows
-- are hidden from the public catalog with the existing `catalog_visible` flag
-- by the mock seed, never deleted.

ALTER TABLE "restaurants"
  ADD COLUMN "slug" TEXT,
  ADD COLUMN "district" TEXT,
  ADD COLUMN "mock" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "rating" DOUBLE PRECISION,
  ADD COLUMN "review_count" INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX "restaurants_slug" ON "restaurants"("slug") WHERE "slug" IS NOT NULL;

ALTER TABLE "restaurants"
  ADD CONSTRAINT "restaurants_rating_check"
  CHECK ("rating" IS NULL OR ("rating" >= 0 AND "rating" <= 5));

ALTER TABLE "menu_items"
  ADD COLUMN "mock" BOOLEAN NOT NULL DEFAULT false;
