CREATE TABLE "delivery_otp_challenges" (
  "id" TEXT PRIMARY KEY,
  "order_id" TEXT NOT NULL,
  "delivery_id" TEXT NOT NULL REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "assignment_id" TEXT NOT NULL REFERENCES "driver_assignments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "customer_id" TEXT NOT NULL,
  "salt" TEXT NOT NULL,
  "otp_hash" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE','REVOKED','VERIFIED','LOCKED','EXPIRED')),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "key_hash" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("order_id", "customer_id", "key_hash")
);
CREATE INDEX "delivery_otp_challenges_order_created" ON "delivery_otp_challenges" ("order_id", "created_at" DESC);
CREATE UNIQUE INDEX "delivery_otp_one_active" ON "delivery_otp_challenges" ("delivery_id") WHERE "status" = 'ACTIVE';

CREATE TABLE "delivery_proofs" (
  "id" TEXT PRIMARY KEY,
  "delivery_id" TEXT NOT NULL REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "assignment_id" TEXT NOT NULL REFERENCES "driver_assignments"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "challenge_id" TEXT UNIQUE REFERENCES "delivery_otp_challenges"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "method" TEXT NOT NULL CHECK ("method" IN ('OTP','PHOTO')),
  "status" TEXT NOT NULL CHECK ("status" IN ('VERIFIED','PURGED')),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "delivery_proofs_assignment" ON "delivery_proofs" ("delivery_id", "assignment_id", "status");

CREATE TABLE "delivery_otp_attempts" (
  "id" TEXT PRIMARY KEY,
  "delivery_id" TEXT NOT NULL REFERENCES "deliveries"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "challenge_id" TEXT NOT NULL REFERENCES "delivery_otp_challenges"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "driver_id" TEXT NOT NULL,
  "key_hash" TEXT NOT NULL,
  "outcome" TEXT NOT NULL CHECK ("outcome" IN ('INVALID','LOCKED','VERIFIED')),
  "proof_id" TEXT REFERENCES "delivery_proofs"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  UNIQUE ("delivery_id", "driver_id", "key_hash")
);
