/**
 * Structured, rate-limited logging for the post-commit Redis publish in the
 * driver GPS ingestion. Redis is only an ephemeral hint: a failed publish must
 * never fail or delay the GPS request, so this module is fire-and-forget and
 * log-only. Coordinates are deliberately never included.
 */

export const PUBLISH_LOG_INTERVAL_MS = 30_000;
export const MAX_TRACKED_DRIVERS = 1_000;

type LogState = { lastLoggedAt: number; suppressed: number };
const states = new Map<string, LogState>();

/**
 * Strip anything that could carry Redis credentials. Whole `redis://` and
 * `rediss://` URLs are replaced, so userinfo, host and query parameters never
 * reach the log. The reason is then collapsed and bounded.
 */
function sanitize(reason: string): string {
  return reason
    .replace(/rediss?:\/\/\S+/gi, 'redis://[redacted]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

/**
 * Keep the map bounded before a new driver is added. Expired entries are
 * forgotten first: their rate-limit window has passed and only a suppressed
 * count would be lost. If the map is still full, the oldest tracked entries
 * go (Map iteration follows insertion order).
 */
function evictForNewDriver(now: number): void {
  if (states.size < MAX_TRACKED_DRIVERS) return;
  for (const [id, state] of states)
    if (now - state.lastLoggedAt >= PUBLISH_LOG_INTERVAL_MS) states.delete(id);
  while (states.size >= MAX_TRACKED_DRIVERS) {
    const oldest = states.keys().next();
    if (oldest.done) break;
    states.delete(oldest.value);
  }
}

/**
 * Emit at most one failure per driver per interval. The first line after a
 * quiet period carries how many failures were suppressed before it.
 * Returns true when a line was written.
 */
export function logLocationPublishFailure(
  driverId: string,
  reason: string,
  now = Date.now(),
  write: (line: string) => void = (line) => console.error(line),
): boolean {
  const previous = states.get(driverId);
  if (previous && now - previous.lastLoggedAt < PUBLISH_LOG_INTERVAL_MS) {
    previous.suppressed += 1;
    return false;
  }
  if (!states.has(driverId)) evictForNewDriver(now);
  states.set(driverId, { lastLoggedAt: now, suppressed: 0 });
  write(
    JSON.stringify({
      level: 'error',
      event: 'driver.location.publish_failed',
      eventName: 'DriverLocationUpdated',
      driverId,
      reason: sanitize(reason),
      timestamp: new Date(now).toISOString(),
      suppressed: previous?.suppressed ?? 0,
    }),
  );
  return true;
}

/** Number of driver ids currently held in memory (diagnostics and tests). */
export function publishFailureLogSize(): number {
  return states.size;
}

/** Forget all tracked drivers; used by tests to keep cases independent. */
export function resetPublishFailureLog(): void {
  states.clear();
}
