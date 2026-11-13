-- P11-T02: incidents get an explicit resolution, actor, evidence references and
-- an append-only history. Status values are made explicit; existing rows keep
-- their status and legacy RESOLVED rows are labelled NO_ACTION.
ALTER TABLE "delivery_incidents"
  ADD COLUMN "actor_id" TEXT,
  ADD COLUMN "evidence" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "resolution" TEXT,
  ADD COLUMN "resolution_reason" TEXT,
  ADD COLUMN "resolved_by" TEXT,
  ADD COLUMN "resolved_at" TIMESTAMPTZ(6);
UPDATE "delivery_incidents"
  SET "resolution" = 'NO_ACTION', "resolution_reason" = 'Legacy incident closed before P11',
      "resolved_at" = "updated_at"
  WHERE "status" <> 'OPEN' AND "resolution" IS NULL;
UPDATE "delivery_incidents" SET "status" = 'RESOLVED' WHERE "status" <> 'OPEN';
ALTER TABLE "delivery_incidents" ADD CONSTRAINT "delivery_incidents_status_check"
  CHECK ("status" IN ('OPEN','RESOLVED'));
ALTER TABLE "delivery_incidents" ADD CONSTRAINT "delivery_incidents_resolution_check"
  CHECK ("resolution" IS NULL OR "resolution" IN ('REFUND_REQUESTED','NO_REFUND','NO_ACTION'));
ALTER TABLE "delivery_incidents" ADD CONSTRAINT "delivery_incidents_resolved_pair"
  CHECK (("status" = 'RESOLVED') = ("resolution" IS NOT NULL AND "resolved_at" IS NOT NULL));
CREATE INDEX "delivery_incidents_status_created" ON "delivery_incidents" ("status", "created_at" DESC, "id" DESC);

CREATE TABLE "delivery_incident_history" (
  "id" TEXT PRIMARY KEY,
  "incident_id" TEXT NOT NULL REFERENCES "delivery_incidents"("id") ON DELETE RESTRICT,
  "action" TEXT NOT NULL CHECK ("action" IN ('OPENED','RESOLVED')),
  "actor_id" TEXT NOT NULL,
  "reason" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX "delivery_incident_history_incident" ON "delivery_incident_history" ("incident_id", "created_at");
INSERT INTO "delivery_incident_history" ("id", "incident_id", "action", "actor_id", "reason", "created_at")
  SELECT 'legacy-open-' || "id", "id", 'OPENED', 'system', "reason", "created_at" FROM "delivery_incidents";
INSERT INTO "delivery_incident_history" ("id", "incident_id", "action", "actor_id", "reason", "created_at")
  SELECT 'legacy-resolved-' || "id", "id", 'RESOLVED', 'system', "resolution_reason", "resolved_at"
  FROM "delivery_incidents" WHERE "status" = 'RESOLVED';
