CREATE UNIQUE INDEX audit_offer_response_command_key
  ON audit_logs (actor, action, resource_id, ((detail->>'keyHash')))
  WHERE action IN ('OFFER_ACCEPTED', 'OFFER_REJECTED') AND detail ? 'keyHash';
