ALTER TABLE "audit_logs"
  ADD COLUMN "resource_type" TEXT,
  ADD COLUMN "outcome" TEXT DEFAULT 'UNKNOWN',
  ADD COLUMN "correlation_id" TEXT;

CREATE UNIQUE INDEX "audit_suspend_command_key"
  ON "audit_logs" ("actor", "action", "resource_id", (("detail"->>'keyHash')))
  WHERE "action" = 'RESTAURANT_SUSPENDED' AND "detail" ? 'keyHash';
