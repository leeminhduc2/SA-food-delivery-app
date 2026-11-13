-- Operational history and acknowledgement are additive; neither changes trip state.
CREATE TABLE "assignment_search_events" (
  "id" TEXT PRIMARY KEY,
  "search_id" TEXT NOT NULL,
  "round" INTEGER NOT NULL,
  "event" TEXT NOT NULL,
  "reason" TEXT,
  "next_run_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX "assignment_search_events_search_created" ON "assignment_search_events" ("search_id", "created_at", "id");

CREATE TABLE "operational_alert_acknowledgements" (
  "kind" TEXT NOT NULL,
  "resource_id" TEXT NOT NULL,
  "actor_id" TEXT NOT NULL,
  "acknowledged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  PRIMARY KEY ("kind", "resource_id")
);
