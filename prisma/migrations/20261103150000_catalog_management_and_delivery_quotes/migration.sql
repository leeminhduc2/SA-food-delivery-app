-- Additive catalog-management flags and a persistent delivery quote cache.
-- No table, column or row is dropped; existing rows keep working with the
-- defaults (visible = true, accepting orders = true).

ALTER TABLE "restaurants" ADD COLUMN "accepting_orders" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "menu_items" ADD COLUMN "visible" BOOLEAN NOT NULL DEFAULT true;
CREATE INDEX "items_restaurant_visible" ON "menu_items"("restaurant_id", "visible");

CREATE TABLE "delivery_quotes" (
  "id" TEXT PRIMARY KEY,
  "address_id" TEXT NOT NULL,
  "restaurant_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "reason" TEXT,
  "distance_meters" INTEGER,
  "duration_seconds" INTEGER,
  "shipping_fee" INTEGER,
  "currency" TEXT NOT NULL DEFAULT 'VND',
  "route_geometry" JSONB,
  "address_latitude" DOUBLE PRECISION NOT NULL,
  "address_longitude" DOUBLE PRECISION NOT NULL,
  "restaurant_latitude" DOUBLE PRECISION NOT NULL,
  "restaurant_longitude" DOUBLE PRECISION NOT NULL,
  "pricing_key" TEXT NOT NULL,
  "computed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "delivery_quotes_status_check" CHECK ("status" IN ('AVAILABLE', 'UNSUPPORTED')),
  CONSTRAINT "delivery_quotes_amounts_check" CHECK (
    ("status" = 'AVAILABLE' AND "distance_meters" IS NOT NULL
      AND "duration_seconds" IS NOT NULL AND "shipping_fee" IS NOT NULL)
    OR ("status" = 'UNSUPPORTED' AND "shipping_fee" IS NULL)
  ),
  CONSTRAINT "delivery_quotes_reason_check" CHECK (
    ("status" = 'AVAILABLE' AND "reason" IS NULL)
    OR ("status" = 'UNSUPPORTED' AND "reason" IS NOT NULL)
  ),
  CONSTRAINT "delivery_quotes_non_negative" CHECK (
    ("distance_meters" IS NULL OR "distance_meters" >= 0)
    AND ("duration_seconds" IS NULL OR "duration_seconds" >= 0)
    AND ("shipping_fee" IS NULL OR "shipping_fee" >= 0)
  )
);

CREATE UNIQUE INDEX "delivery_quotes_address_restaurant_key"
  ON "delivery_quotes"("address_id", "restaurant_id");
CREATE INDEX "delivery_quotes_restaurant_idx" ON "delivery_quotes"("restaurant_id");
CREATE INDEX "delivery_quotes_expires_idx" ON "delivery_quotes"("expires_at");

ALTER TABLE "delivery_quotes"
  ADD CONSTRAINT "delivery_quotes_address_id_fkey"
  FOREIGN KEY ("address_id") REFERENCES "addresses"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "delivery_quotes"
  ADD CONSTRAINT "delivery_quotes_restaurant_id_fkey"
  FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "seed_runs" (
  "name" TEXT PRIMARY KEY,
  "version" INTEGER NOT NULL,
  "applied_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
