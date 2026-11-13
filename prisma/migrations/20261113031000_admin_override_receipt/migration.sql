CREATE UNIQUE INDEX audit_admin_override_command_key
  ON audit_logs (actor, action, resource_id, ((detail->>'keyHash')))
  WHERE action = 'ADMIN_DRIVER_OVERRIDE' AND detail ? 'keyHash';
