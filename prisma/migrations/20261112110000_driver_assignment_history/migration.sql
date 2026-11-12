BEGIN;
LOCK TABLE driver_assignments, deliveries, users IN SHARE ROW EXCLUSIVE MODE;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM driver_assignments a
    LEFT JOIN deliveries d ON d.id = a.delivery_id
    LEFT JOIN users u ON u.id = a.driver_id
    WHERE a.active AND (d.id IS NULL OR u.id IS NULL OR u.role <> 'DRIVER'
      OR d.driver_id IS DISTINCT FROM a.driver_id)
  ) OR EXISTS (
    SELECT 1 FROM driver_assignments a JOIN deliveries d ON d.id = a.delivery_id
    WHERE a.active AND d.status NOT IN ('DELIVERED', 'FAILED', 'CANCELLED')
    GROUP BY a.driver_id HAVING count(*) > 1
  ) OR EXISTS (
    SELECT 1 FROM deliveries d WHERE d.status IN ('ASSIGNED','PICKED_UP','IN_TRANSIT')
    AND (d.driver_id IS NULL OR NOT EXISTS (SELECT 1 FROM driver_assignments a
      WHERE a.delivery_id=d.id AND a.driver_id=d.driver_id AND a.active))
  ) THEN
    RAISE EXCEPTION 'Driver assignment preflight failed; run scripts/preflight-driver-assignments.ts and resolve conflicts';
  END IF;
END $$;
ALTER TABLE driver_assignments ADD COLUMN ended_at timestamptz, ADD COLUMN end_reason text;
INSERT INTO state_history (id, order_id, entity, from_state, to_state, actor, reason, created_at)
SELECT 'migration-close-' || a.id, d.order_id, 'DRIVER_ASSIGNMENT', 'ACTIVE', 'ENDED',
       'system', 'MIGRATION_TERMINAL', now()
FROM driver_assignments a JOIN deliveries d ON d.id = a.delivery_id
WHERE a.active AND d.status IN ('DELIVERED', 'FAILED', 'CANCELLED');
UPDATE driver_assignments a SET active = false, ended_at = now(), end_reason = 'MIGRATION_TERMINAL'
FROM deliveries d WHERE d.id = a.delivery_id AND a.active AND d.status IN ('DELIVERED', 'FAILED', 'CANCELLED');
COMMIT;
