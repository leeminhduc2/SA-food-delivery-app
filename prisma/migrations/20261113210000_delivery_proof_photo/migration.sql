-- P10-T02: private photo proofs. Additive; OTP proofs keep NULL photo metadata.
ALTER TABLE "delivery_proofs"
  ADD COLUMN "driver_id" TEXT,
  ADD COLUMN "storage_key" TEXT UNIQUE,
  ADD COLUMN "content_type" TEXT,
  ADD COLUMN "byte_size" INTEGER,
  ADD COLUMN "sha256" TEXT,
  ADD COLUMN "key_hash" TEXT,
  ADD COLUMN "purged_at" TIMESTAMPTZ(6);

-- PURGING marks bytes being deleted so a failed delete is retried and never served.
ALTER TABLE "delivery_proofs" DROP CONSTRAINT "delivery_proofs_status_check";
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_status_check"
  CHECK ("status" IN ('VERIFIED','PURGING','PURGED'));
ALTER TABLE "delivery_proofs" ADD CONSTRAINT "delivery_proofs_photo_metadata"
  CHECK ("method" <> 'PHOTO' OR (
    "storage_key" IS NOT NULL AND "content_type" IN ('image/jpeg','image/png')
    AND "byte_size" > 0 AND "sha256" IS NOT NULL AND "key_hash" IS NOT NULL AND "driver_id" IS NOT NULL));
CREATE UNIQUE INDEX "delivery_proofs_photo_receipt"
  ON "delivery_proofs" ("delivery_id", "driver_id", "key_hash") WHERE "method" = 'PHOTO';

-- Files written before their proof row commits. Attaching deletes the row in the
-- same transaction; anything left behind is deleted by the cleanup job.
CREATE TABLE "delivery_proof_uploads" (
  "storage_key" TEXT PRIMARY KEY,
  "delivery_id" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "last_error" TEXT,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "delivery_proof_uploads_due" ON "delivery_proof_uploads" ("next_attempt_at");
