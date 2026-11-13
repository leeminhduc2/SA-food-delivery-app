import type { DB } from '../../shared/db.js';
import type { LocationPolicy } from './domain/driver-location-policy.js';
export type LocationRetentionGateway = (driverId: string, now: Date, db: DB) => Promise<boolean>;
let configured:
  | { policy: LocationPolicy; retain: LocationRetentionGateway; trackingTtlSeconds: number }
  | undefined;
export function configureDriverLocation(
  policy: LocationPolicy,
  retain: LocationRetentionGateway,
  trackingTtlSeconds: number,
) {
  configured = { policy, retain, trackingTtlSeconds };
}
export function locationDependencies() {
  if (!configured) throw new Error('Driver location dependencies not configured');
  return configured;
}
