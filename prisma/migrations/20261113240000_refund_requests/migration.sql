-- P11-T03: one refund operation per payment, shared by automatic cancellation,
-- late-payment refunds and Admin-approved complaint/incident refunds. Payment
-- statuses are unchanged: a FAILED request leaves the payment REFUND_PENDING.
CREATE TABLE "refund_requests" (
  "id" TEXT PRIMARY KEY,
  "order_id" TEXT NOT NULL REFERENCES "orders"("id") ON DELETE RESTRICT,
  "payment_id" TEXT NOT NULL REFERENCES "payments"("id") ON DELETE RESTRICT,
  "customer_id" TEXT,
  "source" TEXT NOT NULL CHECK ("source" IN ('INCIDENT','COMPLAINT','CANCELLATION','LATE_PAYMENT','LEGACY')),
  "incident_id" TEXT,
  "complaint_id" TEXT,
  "requested_by" TEXT NOT NULL,
  "requester_role" TEXT NOT NULL CHECK ("requester_role" IN ('CUSTOMER','ADMIN','SYSTEM')),
  "reason" TEXT NOT NULL,
  "amount" INTEGER NOT NULL CHECK ("amount" > 0),
  "status" TEXT NOT NULL CHECK ("status" IN ('REQUESTED','APPROVED','REJECTED','PROCESSING','SUCCEEDED','FAILED')),
  "decided_by" TEXT,
  "decision_reason" TEXT,
  "decided_at" TIMESTAMPTZ(6),
  "attempts" INTEGER NOT NULL DEFAULT 0 CHECK ("attempts" >= 0),
  "next_attempt_at" TIMESTAMPTZ(6),
  "lease_until" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "confirmed_at" TIMESTAMPTZ(6),
  "key_hash" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp(),
  CHECK ("source" <> 'INCIDENT' OR "incident_id" IS NOT NULL),
  CHECK ("source" <> 'COMPLAINT' OR "complaint_id" IS NOT NULL)
);
-- At most one live or completed operation per payment. Only REJECTED frees it.
CREATE UNIQUE INDEX "refund_requests_one_effective" ON "refund_requests" ("payment_id")
  WHERE "status" IN ('REQUESTED','APPROVED','PROCESSING','SUCCEEDED','FAILED');
CREATE UNIQUE INDEX "refund_requests_receipt" ON "refund_requests" ("requested_by", "order_id", "key_hash")
  WHERE "key_hash" IS NOT NULL;
CREATE INDEX "refund_requests_due" ON "refund_requests" ("status", "next_attempt_at");
CREATE INDEX "refund_requests_order" ON "refund_requests" ("order_id", "created_at" DESC);

CREATE TABLE "refund_request_history" (
  "id" TEXT PRIMARY KEY,
  "refund_request_id" TEXT NOT NULL REFERENCES "refund_requests"("id") ON DELETE RESTRICT,
  "from_status" TEXT,
  "to_status" TEXT NOT NULL,
  "actor" TEXT NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "refund_request_history_request" ON "refund_request_history" ("refund_request_id", "created_at");

-- Attach an operation to payments already in the refund queue or refunded, so
-- they are never refunded a second time. No provider call happens here.
INSERT INTO "refund_requests" ("id", "order_id", "payment_id", "source", "requested_by",
  "requester_role", "reason", "amount", "status", "decided_by", "decided_at", "next_attempt_at", "confirmed_at")
SELECT 'legacy-' || p."id", p."order_id", p."id", 'LEGACY', 'system', 'SYSTEM',
  'Refund queued before refund requests existed', p."amount",
  CASE WHEN p."status" = 'REFUNDED' THEN 'SUCCEEDED' ELSE 'APPROVED' END,
  'system', clock_timestamp(),
  CASE WHEN p."status" = 'REFUNDED' THEN NULL ELSE clock_timestamp() END,
  NULL
FROM "payments" p
WHERE p."status" IN ('REFUND_PENDING', 'REFUNDED');
INSERT INTO "refund_request_history" ("id", "refund_request_id", "from_status", "to_status", "actor", "reason")
SELECT 'legacy-' || "id", "id", NULL, "status", 'system', 'Migration attached existing refund state'
FROM "refund_requests" WHERE "source" = 'LEGACY';
