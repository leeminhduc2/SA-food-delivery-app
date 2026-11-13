-- P11-T01: complaints from any order participant. customer_id stays as the
-- legacy alias for Customer reporters and becomes nullable for staff reporters.
ALTER TABLE "complaints"
  ADD COLUMN "reporter_id" TEXT REFERENCES "users"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD COLUMN "reporter_role" TEXT,
  ADD COLUMN "resolved_by" TEXT,
  ADD COLUMN "resolved_at" TIMESTAMPTZ(6);
UPDATE "complaints" SET "reporter_id" = "customer_id", "reporter_role" = 'CUSTOMER'
  WHERE "reporter_id" IS NULL;

-- Processes still running the previous release insert only customer_id; fill
-- the reporter from it so a rolling deploy cannot write an unreadable ticket.
CREATE FUNCTION complaints_legacy_reporter() RETURNS trigger AS $$
BEGIN
  IF NEW.reporter_id IS NULL AND NEW.customer_id IS NOT NULL THEN
    NEW.reporter_id := NEW.customer_id;
    NEW.reporter_role := 'CUSTOMER';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER complaints_legacy_reporter BEFORE INSERT ON "complaints"
  FOR EACH ROW EXECUTE FUNCTION complaints_legacy_reporter();

ALTER TABLE "complaints" ALTER COLUMN "reporter_id" SET NOT NULL;
ALTER TABLE "complaints" ALTER COLUMN "reporter_role" SET NOT NULL;
ALTER TABLE "complaints" ALTER COLUMN "customer_id" DROP NOT NULL;
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_reporter_role_check"
  CHECK ("reporter_role" IN ('CUSTOMER','RESTAURANT','DRIVER'));
ALTER TABLE "complaints" ADD CONSTRAINT "complaints_customer_alias_check"
  CHECK (("reporter_role" = 'CUSTOMER' AND "customer_id" = "reporter_id")
      OR ("reporter_role" <> 'CUSTOMER' AND "customer_id" IS NULL));
CREATE INDEX "complaints_reporter" ON "complaints" ("reporter_id", "created_at" DESC);
CREATE INDEX "complaints_order_status" ON "complaints" ("order_id", "status");

CREATE TABLE "complaint_history" (
  "id" TEXT PRIMARY KEY,
  "complaint_id" TEXT NOT NULL REFERENCES "complaints"("id") ON DELETE RESTRICT,
  "actor_id" TEXT NOT NULL,
  "action" TEXT NOT NULL CHECK ("action" IN ('CREATED','RESOLVED','LEGACY_BACKFILL')),
  "note" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "complaint_history_complaint" ON "complaint_history" ("complaint_id", "created_at");
INSERT INTO "complaint_history" ("id", "complaint_id", "actor_id", "action", "note", "created_at")
  SELECT 'legacy-' || "id", "id", "reporter_id", 'LEGACY_BACKFILL', NULL, "created_at"
  FROM "complaints";

-- One current reply per review with append-only revisions. The review itself
-- is never edited by Restaurant actions.
CREATE TABLE "review_replies" (
  "id" TEXT PRIMARY KEY,
  "review_id" TEXT NOT NULL UNIQUE REFERENCES "reviews"("id") ON DELETE RESTRICT,
  "restaurant_id" TEXT NOT NULL,
  "author_id" TEXT NOT NULL,
  "content" TEXT NOT NULL CHECK (char_length("content") BETWEEN 3 AND 1000),
  "revision" INTEGER NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE "review_reply_revisions" (
  "id" TEXT PRIMARY KEY,
  "reply_id" TEXT NOT NULL REFERENCES "review_replies"("id") ON DELETE RESTRICT,
  "revision" INTEGER NOT NULL,
  "author_id" TEXT NOT NULL,
  "content" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("reply_id", "revision")
);
CREATE UNIQUE INDEX "review_reply_revisions_receipt"
  ON "review_reply_revisions" ("author_id", "reply_id", "key_hash");

CREATE TABLE "review_moderation_requests" (
  "id" TEXT PRIMARY KEY,
  "review_id" TEXT NOT NULL REFERENCES "reviews"("id") ON DELETE RESTRICT,
  "restaurant_id" TEXT NOT NULL,
  "requester_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING','APPROVED','REJECTED')),
  "decided_by" TEXT,
  "decision_reason" TEXT,
  "decided_at" TIMESTAMPTZ(6),
  "key_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("requester_id", "review_id", "key_hash"),
  CHECK (("status" = 'PENDING') = ("decided_at" IS NULL))
);
CREATE UNIQUE INDEX "review_moderation_one_pending"
  ON "review_moderation_requests" ("review_id") WHERE "status" = 'PENDING';
CREATE INDEX "review_moderation_status" ON "review_moderation_requests" ("status", "created_at");
