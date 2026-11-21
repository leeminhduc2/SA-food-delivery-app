/**
 * Pure GPS error classification and retry pacing for the driver availability
 * panel. It lives outside the component so every HTTP status group can be
 * unit tested without a browser.
 */

export class RequestError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'RequestError';
    this.status = status;
    this.code = code;
  }
}

/** Normal cadence between positions. The server accepts one every 5 s. */
export const LOCATION_SEND_INTERVAL_MS = 10_000;
/** Upper bound for the exponential backoff on transient failures. */
export const LOCATION_MAX_RETRY_DELAY_MS = 300_000;

export type LocationErrorKind =
  | 'validation'
  | 'unauthenticated'
  | 'forbidden'
  | 'rate-limited'
  | 'out-of-order'
  | 'stale'
  | 'conflict'
  | 'rejected'
  | 'transient';

export type LocationErrorDecision = {
  kind: LocationErrorKind;
  message: string;
  /** The error cannot be fixed by sending another position: stop watching. */
  stop: boolean;
  /** Widen the interval before the next accepted fix is sent. */
  backoff: boolean;
};

const DECISIONS: Record<LocationErrorKind, LocationErrorDecision> = {
  validation: {
    kind: 'validation',
    message:
      'Location data was rejected by the server. Check that device location is enabled, then enable sharing again.',
    stop: true,
    backoff: false,
  },
  unauthenticated: {
    kind: 'unauthenticated',
    message: 'Your session has expired. Sign in again to share your location.',
    stop: true,
    backoff: false,
  },
  forbidden: {
    kind: 'forbidden',
    message:
      'Your driver account is not allowed to share location right now. Contact support if this continues.',
    stop: true,
    backoff: false,
  },
  'rate-limited': {
    kind: 'rate-limited',
    message: 'Location updates are rate limited. The next position will be sent automatically.',
    stop: false,
    backoff: false,
  },
  'out-of-order': {
    kind: 'out-of-order',
    message: 'A newer position was already saved. The next position will be sent automatically.',
    stop: false,
    backoff: false,
  },
  stale: {
    kind: 'stale',
    message:
      'This position was too old, or your device clock is wrong, to be accepted. Check your device time; the next position will be sent automatically.',
    stop: false,
    backoff: true,
  },
  conflict: {
    kind: 'conflict',
    message:
      'The server rejected this location update (conflict). Enable location sharing again to retry.',
    stop: true,
    backoff: false,
  },
  rejected: {
    kind: 'rejected',
    message:
      'Location updates are not available right now. Enable location sharing again to retry.',
    stop: true,
    backoff: false,
  },
  transient: {
    kind: 'transient',
    message: 'Location update failed. Retrying with a longer delay.',
    stop: false,
    backoff: true,
  },
};

export function classifyLocationResponse(status: number, code?: string): LocationErrorDecision {
  if (status === 400) return DECISIONS.validation;
  if (status === 401) return DECISIONS.unauthenticated;
  if (status === 403) return DECISIONS.forbidden;
  if (status === 429) return DECISIONS['rate-limited'];
  if (status === 409)
    // Only these two conflicts are business-recoverable: the next fix carries
    // a newer timestamp and can be accepted. Any other conflict stops sharing.
    return code === 'LOCATION_OUT_OF_ORDER'
      ? DECISIONS['out-of-order']
      : code === 'STALE_LOCATION'
        ? DECISIONS.stale
        : DECISIONS.conflict;
  if (status === 408 || status >= 500) return DECISIONS.transient;
  // Other 4xx responses mean the request will not succeed as-is.
  if (status >= 400) return DECISIONS.rejected;
  return DECISIONS.transient;
}

export function classifyLocationFailure(failure: unknown): LocationErrorDecision {
  if (failure instanceof RequestError)
    return classifyLocationResponse(failure.status, failure.code);
  // fetch network errors, aborts after a session change, and unexpected throws.
  return DECISIONS.transient;
}

/** 10 s → 20 s → 40 s … capped at 5 minutes. */
export function nextRetryDelay(current: number): number {
  const base = Number.isFinite(current) && current > 0 ? current : LOCATION_SEND_INTERVAL_MS;
  return Math.min(Math.max(base * 2, LOCATION_SEND_INTERVAL_MS), LOCATION_MAX_RETRY_DELAY_MS);
}
