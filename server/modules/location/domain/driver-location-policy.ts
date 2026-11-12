export type LocationPolicy = {
  maxAgeSeconds: number;
  maxFutureSeconds: number;
  minIntervalSeconds: number;
  retentionSeconds: number;
};
export type LocationFailure = 'STALE_LOCATION' | 'LOCATION_OUT_OF_ORDER' | 'LOCATION_RATE_LIMITED';
export function validateLocationTime(
  capturedAt: Date,
  now: Date,
  previous: { captured_at: Date; received_at: Date } | null,
  policy: LocationPolicy,
): LocationFailure | null {
  const age = now.getTime() - capturedAt.getTime();
  if (
    !Number.isFinite(capturedAt.getTime()) ||
    age > policy.maxAgeSeconds * 1000 ||
    age < -policy.maxFutureSeconds * 1000
  )
    return 'STALE_LOCATION';
  if (previous && capturedAt.getTime() <= previous.captured_at.getTime())
    return 'LOCATION_OUT_OF_ORDER';
  if (previous && now.getTime() - previous.received_at.getTime() < policy.minIntervalSeconds * 1000)
    return 'LOCATION_RATE_LIMITED';
  return null;
}
