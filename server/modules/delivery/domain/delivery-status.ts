/** Delivery lifecycle rules. Pure functions: no database, no HTTP. */
const DRIVER_STEPS: Record<string, string[]> = {
  ASSIGNED: ['PICKED_UP'],
  PICKED_UP: ['IN_TRANSIT', 'FAILED'],
  IN_TRANSIT: ['DELIVERED', 'FAILED'],
};

export function canDriverTransition(from: string, to: string): boolean {
  return DRIVER_STEPS[from]?.includes(to) ?? false;
}

/** Deliveries can be (re)assigned or cancelled until a driver picks the food up. */
export function isOpen(status: string): boolean {
  return status === 'UNASSIGNED' || status === 'ASSIGNED';
}

export function hasFailureReason(reason: string): boolean {
  return reason.trim().length >= 3;
}
