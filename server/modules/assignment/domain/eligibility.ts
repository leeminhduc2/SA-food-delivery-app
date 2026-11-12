export function isEligibleForAssignment(input: {
  active: boolean;
  online: boolean;
  ready: boolean;
  heartbeatFresh: boolean;
  locationFresh: boolean;
  busy: boolean;
}): boolean {
  return (
    input.active &&
    input.online &&
    input.ready &&
    input.heartbeatFresh &&
    input.locationFresh &&
    !input.busy
  );
}
