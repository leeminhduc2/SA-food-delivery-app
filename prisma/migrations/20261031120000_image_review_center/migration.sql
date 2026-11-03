-- Additive migration for the bulk image review and approval center.
-- The applied baseline migration is intentionally untouched.

-- CreateTable
CREATE TABLE "image_discovery_batches" (
    "id" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "filters" JSONB NOT NULL DEFAULT '{}',
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "succeeded_count" INTEGER NOT NULL DEFAULT 0,
    "failed_count" INTEGER NOT NULL DEFAULT 0,
    "candidate_count" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "image_discovery_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "image_candidates" (
    "id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "discovery_batch_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_image_id" TEXT NOT NULL,
    "title" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "image_url" TEXT NOT NULL,
    "thumbnail_url" TEXT NOT NULL,
    "author" TEXT NOT NULL,
    "source_url" TEXT NOT NULL,
    "license" TEXT NOT NULL,
    "license_url" TEXT NOT NULL,
    "image_type" TEXT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "search_query" TEXT NOT NULL,
    "relevance_label" TEXT NOT NULL DEFAULT 'SEARCH_MATCH',
    "review_status" TEXT NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "image_candidates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "menu_item_image_reviews" (
    "menu_item_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "selected_candidate_id" TEXT,
    "updated_by" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "menu_item_image_reviews_pkey" PRIMARY KEY ("menu_item_id")
);

-- CreateTable
CREATE TABLE "image_approvals" (
    "id" TEXT NOT NULL,
    "menu_item_id" TEXT NOT NULL,
    "candidate_id" TEXT NOT NULL,
    "approved_by" TEXT NOT NULL,
    "previous_image" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "approved_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

    CONSTRAINT "image_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "image_discovery_recent" ON "image_discovery_batches"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "image_candidate_identity" ON "image_candidates"("menu_item_id", "provider", "provider_image_id");

-- CreateIndex
CREATE UNIQUE INDEX "image_candidate_batch_identity" ON "image_candidates"("discovery_batch_id", "provider", "provider_image_id");

-- CreateIndex
CREATE INDEX "image_candidates_item" ON "image_candidates"("menu_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "image_reviews_selected" ON "menu_item_image_reviews"("selected_candidate_id");

-- CreateIndex
CREATE INDEX "image_reviews_status" ON "menu_item_image_reviews"("status");

-- CreateIndex
CREATE INDEX "image_approvals_item" ON "image_approvals"("menu_item_id", "approved_at" DESC);

-- CreateIndex
CREATE INDEX "image_approvals_candidate" ON "image_approvals"("candidate_id");

-- AddForeignKey
ALTER TABLE "image_candidates" ADD CONSTRAINT "image_candidates_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "image_candidates" ADD CONSTRAINT "image_candidates_discovery_batch_id_fkey" FOREIGN KEY ("discovery_batch_id") REFERENCES "image_discovery_batches"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "menu_item_image_reviews" ADD CONSTRAINT "menu_item_image_reviews_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "menu_item_image_reviews" ADD CONSTRAINT "menu_item_image_reviews_selected_candidate_id_fkey" FOREIGN KEY ("selected_candidate_id") REFERENCES "image_candidates"("id") ON DELETE SET NULL ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "image_approvals" ADD CONSTRAINT "image_approvals_menu_item_id_fkey" FOREIGN KEY ("menu_item_id") REFERENCES "menu_items"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "image_approvals" ADD CONSTRAINT "image_approvals_candidate_id_fkey" FOREIGN KEY ("candidate_id") REFERENCES "image_candidates"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- CHECK constraints (not representable in schema.prisma)
ALTER TABLE "image_discovery_batches" ADD CONSTRAINT "image_discovery_batches_status_check" CHECK ("status" IN ('RUNNING','SUCCEEDED','PARTIAL','FAILED'));
ALTER TABLE "image_candidates" ADD CONSTRAINT "image_candidates_review_status_check" CHECK ("review_status" IN ('PENDING','APPROVED','REJECTED'));
ALTER TABLE "image_candidates" ADD CONSTRAINT "image_candidates_image_url_check" CHECK ("image_url" LIKE 'https://%');
ALTER TABLE "image_candidates" ADD CONSTRAINT "image_candidates_thumbnail_url_check" CHECK ("thumbnail_url" LIKE 'https://%');
ALTER TABLE "image_candidates" ADD CONSTRAINT "image_candidates_source_url_check" CHECK ("source_url" LIKE 'https://%');
ALTER TABLE "image_candidates" ADD CONSTRAINT "image_candidates_license_url_check" CHECK ("license_url" LIKE 'https://%');
ALTER TABLE "menu_item_image_reviews" ADD CONSTRAINT "menu_item_image_reviews_status_check" CHECK ("status" IN ('PENDING','APPROVED','REJECTED','SKIPPED','NO_SUITABLE'));

-- Partial index (not representable in schema.prisma)
CREATE UNIQUE INDEX "image_approval_one_active" ON "image_approvals"("menu_item_id") WHERE "active" = true;
