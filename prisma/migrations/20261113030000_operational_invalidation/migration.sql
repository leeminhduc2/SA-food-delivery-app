ALTER TABLE driver_operational_changes
  ADD COLUMN lease_owner TEXT,
  ADD COLUMN lease_until TIMESTAMPTZ,
  ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD CONSTRAINT operational_change_lease_pair CHECK ((lease_owner IS NULL) = (lease_until IS NULL));
CREATE UNIQUE INDEX driver_operational_one_recheck ON driver_operational_changes(driver_id)
  WHERE source = 'RECHECK' AND processed_at IS NULL;

CREATE TABLE delivery_incidents (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES deliveries(id),
  order_id TEXT NOT NULL REFERENCES orders(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN',
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX delivery_incident_one_open_type ON delivery_incidents(delivery_id, type) WHERE status = 'OPEN';
CREATE INDEX delivery_incidents_delivery_status ON delivery_incidents(delivery_id, status);
