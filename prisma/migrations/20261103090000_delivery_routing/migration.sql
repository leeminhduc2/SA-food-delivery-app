-- Additive delivery-address and walking-route snapshots.
-- No existing column, table, row or constraint is removed or rewritten.

CREATE TABLE "addresses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "formatted_address" TEXT,
    "latitude" DOUBLE PRECISION NOT NULL,
    "longitude" DOUBLE PRECISION NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "addresses_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "addresses_user" ON "addresses"("user_id");

-- At most one default address per account. Older addresses may be kept, but
-- the API currently manages only the default one.
CREATE UNIQUE INDEX "addresses_one_default"
    ON "addresses"("user_id")
    WHERE "is_default" = true;

ALTER TABLE "addresses"
    ADD CONSTRAINT "addresses_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

ALTER TABLE "restaurants"
    ADD COLUMN "geocoded_address" TEXT,
    ADD COLUMN "geocoded_at" TIMESTAMPTZ(6);

-- Historical orders keep NULL here; they were placed before route pricing.
ALTER TABLE "orders"
    ADD COLUMN "delivery_latitude" DOUBLE PRECISION,
    ADD COLUMN "delivery_longitude" DOUBLE PRECISION,
    ADD COLUMN "walking_distance_meters" INTEGER,
    ADD COLUMN "walking_duration_seconds" INTEGER;
