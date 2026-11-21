export type EligibilityInput = {
  active: boolean;
  online: boolean;
  ready: boolean;
  heartbeatFresh: boolean;
  locationFresh: boolean;
  busy: boolean;
};

export type EligibilityFailure =
  | 'ACCOUNT_INACTIVE'
  | 'DRIVER_OFFLINE'
  | 'DRIVER_NOT_READY'
  | 'HEARTBEAT_STALE'
  | 'LOCATION_STALE'
  | 'DRIVER_BUSY';

/**
 * The single source of truth for driver eligibility. Diagnostics report the
 * first failing condition without maintaining a second copy of this policy.
 */
export function eligibilityFailure(input: EligibilityInput): EligibilityFailure | null {
  if (!input.active) return 'ACCOUNT_INACTIVE';
  if (!input.online) return 'DRIVER_OFFLINE';
  if (!input.ready) return 'DRIVER_NOT_READY';
  if (!input.heartbeatFresh) return 'HEARTBEAT_STALE';
  if (!input.locationFresh) return 'LOCATION_STALE';
  if (input.busy) return 'DRIVER_BUSY';
  return null;
}

export function isEligibleForAssignment(input: EligibilityInput): boolean {
  return eligibilityFailure(input) === null;
}
