CREATE TABLE assignment_searches (
  id TEXT PRIMARY KEY, delivery_id TEXT NOT NULL REFERENCES deliveries(id), generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
  status TEXT NOT NULL DEFAULT 'WAITING' CHECK (status IN ('WAITING','SEARCHING','OFFERED','ASSIGNED','EXHAUSTED','CANCELLED')),
  strategy TEXT NOT NULL DEFAULT 'NEAREST', round INTEGER NOT NULL DEFAULT 1 CHECK (round > 0),
  offers_created INTEGER NOT NULL DEFAULT 0 CHECK (offers_created >= 0), deadline_at TIMESTAMPTZ NOT NULL,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT now(), lease_owner TEXT, lease_until TIMESTAMPTZ,
  version INTEGER NOT NULL DEFAULT 0 CHECK (version >= 0), created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(), CONSTRAINT assignment_search_delivery_generation_key UNIQUE(delivery_id, generation),
  CHECK ((lease_owner IS NULL) = (lease_until IS NULL))
);
CREATE UNIQUE INDEX assignment_search_one_live_delivery ON assignment_searches(delivery_id) WHERE status IN ('WAITING','SEARCHING','OFFERED');
CREATE INDEX assignment_search_due ON assignment_searches(status, next_run_at);
CREATE TABLE driver_offers (
  id TEXT PRIMARY KEY, search_id TEXT NOT NULL REFERENCES assignment_searches(id), driver_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'OFFERED' CHECK (status IN ('OFFERED','ACCEPTED','REJECTED','EXPIRED','REVOKED')),
  expires_at TIMESTAMPTZ NOT NULL, responded_at TIMESTAMPTZ, assignment_id TEXT REFERENCES driver_assignments(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX driver_offers_one_live_driver ON driver_offers(driver_id) WHERE status = 'OFFERED';
CREATE UNIQUE INDEX driver_offers_one_live_search ON driver_offers(search_id) WHERE status = 'OFFERED';
CREATE INDEX driver_offers_search ON driver_offers(search_id, created_at);
CREATE TABLE assignment_attempts (
  id TEXT PRIMARY KEY, search_id TEXT NOT NULL REFERENCES assignment_searches(id), driver_id TEXT NOT NULL REFERENCES users(id),
  round INTEGER NOT NULL CHECK (round > 0), rank INTEGER CHECK (rank > 0), criterion JSONB, offer_id TEXT REFERENCES driver_offers(id),
  outcome TEXT NOT NULL CHECK (outcome IN ('INELIGIBLE','OFFERED','ACCEPTED','REJECTED','EXPIRED','REVOKED')),
  reason TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assignment_attempt_search_driver_key UNIQUE(search_id, driver_id)
);
