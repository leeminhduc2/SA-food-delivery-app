-- The ledger starts at each item's locked opening balance; no historical movements are inferred.
CREATE TABLE "stock_movements" (
  "id" TEXT PRIMARY KEY,
  "item_id" TEXT NOT NULL REFERENCES "menu_items"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "kind" TEXT NOT NULL,
  "delta" INTEGER NOT NULL,
  "balance_after" INTEGER NOT NULL CHECK ("balance_after" >= 0),
  "actor" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "operation_key" TEXT NOT NULL,
  "order_id" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("item_id", "operation_key")
);
CREATE INDEX "stock_movements_item_time" ON "stock_movements" ("item_id", "created_at" DESC, "id" DESC);
