-- P12-T02: simulated earning estimate = 100% of the delivery fee snapshot of a
-- DELIVERED trip, one per delivery for the final driver. Not a payout (EXT02).
CREATE TABLE "driver_earning_estimates" (
  "id" TEXT PRIMARY KEY,
  "delivery_id" TEXT NOT NULL UNIQUE REFERENCES "deliveries"("id") ON DELETE RESTRICT,
  "order_id" TEXT NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "driver_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE RESTRICT,
  "amount" INTEGER NOT NULL CHECK ("amount" >= 0),
  "currency" TEXT NOT NULL DEFAULT 'VND' CHECK ("currency" = 'VND'),
  "delivered_at" TIMESTAMPTZ(6) NOT NULL,
  "basis" TEXT NOT NULL DEFAULT 'SIMULATED_ESTIMATE' CHECK ("basis" = 'SIMULATED_ESTIMATE'),
  "source" TEXT NOT NULL CHECK ("source" IN ('DELIVERY_COMPLETED','BACKFILL')),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "driver_earning_estimates_driver_time"
  ON "driver_earning_estimates" ("driver_id", "delivered_at" DESC, "id" DESC);
CREATE INDEX "deliveries_driver_terminal_time"
  ON "deliveries" ("driver_id", "delivered_at", "failed_at");
