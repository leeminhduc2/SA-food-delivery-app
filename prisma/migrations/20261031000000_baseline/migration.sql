-- Baseline for the existing PostgreSQL schema (see docs/PRISMA.md).
--
-- Generated with:
--   prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script
-- then extended with the CHECK constraints and partial indexes that Prisma
-- cannot represent in schema.prisma. Those additions mirror server/schema.sql
-- exactly, so a fresh database created by this baseline matches the live one.
--
-- DO NOT apply this migration to the existing database. It is the baseline for
-- fresh environments; the existing database is marked as already baselined with
--   prisma migrate resolve --applied 20261031000000_baseline
-- only after explicit approval and a verified backup.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "token_hash" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("token_hash")
);

-- CreateTable
CREATE TABLE "restaurants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "cuisine" TEXT NOT NULL,
    "image" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "delivery_fee" INTEGER NOT NULL DEFAULT 15000,
    "eta_minutes" INTEGER NOT NULL DEFAULT 30,
    "approved_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "verified" BOOLEAN NOT NULL DEFAULT true,
    "owner_managed" BOOLEAN NOT NULL DEFAULT true,
    "osm_type" TEXT,
    "osm_id" TEXT,
    "latitude" DOUBLE PRECISION,
    "longitude" DOUBLE PRECISION,
    "phone" TEXT,
    "website" TEXT,
    "opening_hours" TEXT,
    "address_tags" JSONB NOT NULL DEFAULT '{}',
    "osm_tags" JSONB NOT NULL DEFAULT '{}',
    "imported_at" TIMESTAMPTZ,
    "last_synced_at" TIMESTAMPTZ,

    CONSTRAINT "restaurants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_import_jobs" (
    "id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "bbox" TEXT NOT NULL,
    "dry_run" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "stats" JSONB NOT NULL DEFAULT '{}',
    "error" TEXT,
    "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "finished_at" TIMESTAMPTZ,

    CONSTRAINT "restaurant_import_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "restaurant_members" (
    "user_id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,

    CONSTRAINT "restaurant_members_pkey" PRIMARY KEY ("user_id","restaurant_id")
);

-- CreateTable
CREATE TABLE "menus" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "menus_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_items" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "menu_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "price" INTEGER NOT NULL,
    "image" TEXT NOT NULL DEFAULT '',
    "available" BOOLEAN NOT NULL DEFAULT true,
    "stock" INTEGER NOT NULL DEFAULT 30,
    "options" JSONB NOT NULL DEFAULT '[]',

    CONSTRAINT "menu_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "carts" (
    "customer_id" TEXT NOT NULL,
    "items" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "carts_pkey" PRIMARY KEY ("customer_id")
);

-- CreateTable
CREATE TABLE "orders" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "subtotal" INTEGER NOT NULL,
    "delivery_fee" INTEGER NOT NULL,
    "total" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "address" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',
    "idempotency_key" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "stock_released" BOOLEAN NOT NULL DEFAULT false,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "order_items" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "price" INTEGER NOT NULL,
    "quantity" INTEGER NOT NULL,
    "options" JSONB NOT NULL,

    CONSTRAINT "order_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'VND',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "external_transaction_id" TEXT,
    "provider_created" BOOLEAN NOT NULL DEFAULT false,
    "reconciliation_required" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "next_reconcile_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "event_id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("event_id")
);

-- CreateTable
CREATE TABLE "simulated_transactions" (
    "reference" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "external_id" TEXT NOT NULL,

    CONSTRAINT "simulated_transactions_pkey" PRIMARY KEY ("reference")
);

-- CreateTable
CREATE TABLE "deliveries" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "driver_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNASSIGNED',
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "driver_assignments" (
    "id" TEXT NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "driver_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "assigned_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "driver_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_history" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "from_state" TEXT,
    "to_state" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "sequence" BIGSERIAL NOT NULL,

    CONSTRAINT "state_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "processed_at" TIMESTAMPTZ,
    "last_error" TEXT,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reviews" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "rating" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "hidden" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "complaints" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "complaints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
ALTER TABLE "users" ADD CONSTRAINT "users_email_key" UNIQUE ("email");

-- CreateIndex
CREATE INDEX "restaurant_import_recent" ON "restaurant_import_jobs"("started_at" DESC);

-- CreateIndex
ALTER TABLE "menus" ADD CONSTRAINT "menus_restaurant_id_name_key" UNIQUE ("restaurant_id", "name");

-- CreateIndex
CREATE INDEX "items_restaurant" ON "menu_items"("restaurant_id");

-- CreateIndex
CREATE INDEX "orders_customer" ON "orders"("customer_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "orders_restaurant" ON "orders"("restaurant_id", "status");

-- CreateIndex
CREATE INDEX "orders_pending" ON "orders"("status", "expires_at");

-- CreateIndex
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_idempotency_key_key" UNIQUE ("customer_id", "idempotency_key");

-- CreateIndex
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_key" UNIQUE ("order_id");

-- CreateIndex
ALTER TABLE "payments" ADD CONSTRAINT "payments_reference_key" UNIQUE ("reference");

-- CreateIndex
ALTER TABLE "payments" ADD CONSTRAINT "payments_external_transaction_id_key" UNIQUE ("external_transaction_id");

-- CreateIndex
ALTER TABLE "simulated_transactions" ADD CONSTRAINT "simulated_transactions_external_id_key" UNIQUE ("external_id");

-- CreateIndex
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_key" UNIQUE ("order_id");

-- CreateIndex
CREATE INDEX "deliveries_driver" ON "deliveries"("driver_id", "status");

-- CreateIndex
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_key" UNIQUE ("order_id");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "restaurant_members" ADD CONSTRAINT "restaurant_members_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "restaurant_members" ADD CONSTRAINT "restaurant_members_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "menus" ADD CONSTRAINT "menus_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_menu_id_fkey" FOREIGN KEY ("menu_id") REFERENCES "menus"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "carts" ADD CONSTRAINT "carts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "orders" ADD CONSTRAINT "orders_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_reference_fkey" FOREIGN KEY ("reference") REFERENCES "payments"("reference") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_delivery_id_fkey" FOREIGN KEY ("delivery_id") REFERENCES "deliveries"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "driver_assignments" ADD CONSTRAINT "driver_assignments_driver_id_fkey" FOREIGN KEY ("driver_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "state_history" ADD CONSTRAINT "state_history_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_id_fkey" FOREIGN KEY ("id") REFERENCES "outbox"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- CHECK constraints (not representable in schema.prisma)
-- ---------------------------------------------------------------------------
ALTER TABLE "users" ADD CONSTRAINT "users_role_check" CHECK (role IN ('CUSTOMER','RESTAURANT','DRIVER','ADMIN'));
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_status_check" CHECK (status IN ('PENDING','APPROVED','REJECTED'));
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_delivery_fee_check" CHECK (delivery_fee >= 0);
ALTER TABLE "restaurants" ADD CONSTRAINT "restaurants_eta_minutes_check" CHECK (eta_minutes > 0);
ALTER TABLE "restaurant_import_jobs" ADD CONSTRAINT "restaurant_import_jobs_status_check" CHECK (status IN ('RUNNING','SUCCEEDED','FAILED'));
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_price_check" CHECK (price > 0);
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_stock_check" CHECK (stock >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_status_check" CHECK (status IN ('PENDING_PAYMENT','CONFIRMED','ACCEPTED','PREPARING','READY_FOR_PICKUP','OUT_FOR_DELIVERY','DELIVERED','CANCELLED','PAYMENT_FAILED','DELIVERY_FAILED'));
ALTER TABLE "orders" ADD CONSTRAINT "orders_subtotal_check" CHECK (subtotal >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_delivery_fee_check" CHECK (delivery_fee >= 0);
ALTER TABLE "orders" ADD CONSTRAINT "orders_check" CHECK (total = subtotal + delivery_fee);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_price_check" CHECK (price > 0);
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_quantity_check" CHECK (quantity > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK (amount > 0);
ALTER TABLE "payments" ADD CONSTRAINT "payments_status_check" CHECK (status IN ('PENDING','SUCCEEDED','FAILED','EXPIRED','REFUND_PENDING','REFUNDED'));
ALTER TABLE "deliveries" ADD CONSTRAINT "deliveries_status_check" CHECK (status IN ('UNASSIGNED','ASSIGNED','PICKED_UP','IN_TRANSIT','DELIVERED','FAILED','CANCELLED'));
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_rating_check" CHECK (rating BETWEEN 1 AND 5);
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_status_check" CHECK (status IN ('OPEN','RESOLVED'));

-- ---------------------------------------------------------------------------
-- Partial indexes (not representable in schema.prisma)
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "restaurants_osm_identity" ON "restaurants"("osm_type", "osm_id") WHERE "osm_type" IS NOT NULL AND "osm_id" IS NOT NULL;
CREATE UNIQUE INDEX "restaurant_import_one_running" ON "restaurant_import_jobs"("status") WHERE "status" = 'RUNNING';
CREATE UNIQUE INDEX "assignment_active" ON "driver_assignments"("delivery_id") WHERE "active" = true;
CREATE INDEX "outbox_pending" ON "outbox"("available_at") WHERE "processed_at" IS NULL;
