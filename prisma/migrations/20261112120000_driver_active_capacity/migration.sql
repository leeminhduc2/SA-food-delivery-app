BEGIN;
LOCK TABLE driver_assignments IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM driver_assignments WHERE active GROUP BY driver_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Active driver capacity conflict; run driver assignment preflight';
  END IF;
END $$;
CREATE UNIQUE INDEX driver_assignment_one_active_per_driver ON driver_assignments(driver_id) WHERE active = true;
COMMIT;
