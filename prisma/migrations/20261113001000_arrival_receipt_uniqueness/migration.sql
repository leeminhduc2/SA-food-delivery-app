CREATE UNIQUE INDEX audit_arrival_command_key
  ON audit_logs (actor, action, resource_id, ((detail->>'keyHash')))
  WHERE action = 'ARRIVAL_RECEIPT' AND detail ? 'keyHash';
