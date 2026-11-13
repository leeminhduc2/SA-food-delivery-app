ALTER TABLE "menu_items" ADD COLUMN "low_stock_threshold" INTEGER
  CHECK ("low_stock_threshold" >= 0 AND "low_stock_threshold" <= 100000);
