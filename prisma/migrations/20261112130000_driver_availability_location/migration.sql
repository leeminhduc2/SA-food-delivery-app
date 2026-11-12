CREATE TABLE driver_availability (
  driver_id TEXT PRIMARY KEY REFERENCES users(id), online BOOLEAN NOT NULL DEFAULT false,
  ready BOOLEAN NOT NULL DEFAULT false, heartbeat_at TIMESTAMPTZ, version INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE driver_operational_changes (
  id TEXT PRIMARY KEY, driver_id TEXT NOT NULL REFERENCES users(id), source TEXT NOT NULL,
  reason TEXT NOT NULL, observed_version INTEGER, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), processed_at TIMESTAMPTZ
);
CREATE INDEX driver_operational_pending ON driver_operational_changes(created_at) WHERE processed_at IS NULL;
CREATE TABLE driver_locations (
  driver_id TEXT PRIMARY KEY REFERENCES users(id), latitude DOUBLE PRECISION NOT NULL,
  longitude DOUBLE PRECISION NOT NULL, captured_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL,
  version INTEGER NOT NULL DEFAULT 1
);
