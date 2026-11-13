import { isValidCoordinate, type LatLng, type WalkingRoute } from '../domain/geo.js';
import { RoutingProviderError, activeRoutingProvider } from '../infrastructure/routing.client.js';

export { RoutingProviderError };

type CacheEntry = { value: WalkingRoute; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<WalkingRoute>>();
const CACHE_MAX = 500;
let active = 0;
const waiters: (() => void)[] = [];

function maxConcurrency(): number {
  return Math.max(1, Number(process.env.ROUTING_MAX_CONCURRENCY || 3));
}

function timeoutMs(): number {
  return Math.max(1_000, Number(process.env.ROUTING_TIMEOUT_MS || 6_000));
}

function cacheTtlMs(): number {
  return Number(process.env.ROUTING_CACHE_TTL_SECONDS || 600) * 1_000;
}

function keyFor(from: LatLng, to: LatLng): string {
  return [from.latitude, from.longitude, to.latitude, to.longitude]
    .map((value) => value.toFixed(5))
    .join(',');
}

async function acquire(): Promise<void> {
  if (active < maxConcurrency()) {
    active++;
    return;
  }
  // The releasing request hands its slot straight to this waiter.
  await new Promise<void>((resolve) => waiters.push(resolve));
}

function release(): void {
  const next = waiters.shift();
  if (next) next();
  else active--;
}

async function callProvider(from: LatLng, to: LatLng): Promise<WalkingRoute> {
  await acquire();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const route = await Promise.race([
      activeRoutingProvider.walkingRoute(from, to),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new RoutingProviderError('TIMEOUT', 'The walking router took too long.')),
          timeoutMs() + 500,
        );
      }),
    ]);
    if (
      !Number.isFinite(route.distanceMeters) ||
      route.distanceMeters < 0 ||
      !Number.isFinite(route.durationSeconds) ||
      route.durationSeconds < 0 ||
      !route.routeGeometry ||
      route.routeGeometry.type !== 'LineString' ||
      !Array.isArray(route.routeGeometry.coordinates) ||
      route.routeGeometry.coordinates.length < 2 ||
      !route.routeGeometry.coordinates.every(
        (point) =>
          Array.isArray(point) && point.length === 2 && isValidCoordinate(point[1], point[0]),
      )
    )
      throw new RoutingProviderError(
        'INVALID_RESPONSE',
        'The walking route response was incomplete.',
      );
    return route;
  } finally {
    if (timer) clearTimeout(timer);
    release();
  }
}

function validateEndpoints(from: LatLng, to: LatLng): void {
  if (!isValidCoordinate(from.latitude, from.longitude))
    throw new RoutingProviderError('INVALID_COORDINATES', 'The delivery address is invalid.');
  if (!isValidCoordinate(to.latitude, to.longitude))
    throw new RoutingProviderError(
      'INVALID_COORDINATES',
      'The restaurant does not have a valid walking location.',
    );
}

/** A live-driver route is never cached, so changing positions do not form a trajectory. */
export async function liveWalkingRoute(from: LatLng, to: LatLng): Promise<WalkingRoute> {
  validateEndpoints(from, to);
  return callProvider(from, to);
}

export async function walkingRoute(from: LatLng, to: LatLng): Promise<WalkingRoute> {
  validateEndpoints(from, to);
  const key = keyFor(from, to);
  const hit = cache.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) return hit.value;
    cache.delete(key);
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  const request = callProvider(from, to)
    .then((route) => {
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value;
        if (oldest) cache.delete(oldest);
      }
      cache.set(key, { value: route, expiresAt: Date.now() + cacheTtlMs() });
      return route;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, request);
  return request;
}

/** Test seam. */
export function clearRoutingCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Walking ETA for assignment ranking. Uses the live (uncached) path so driver
 * positions are not retained, with the same timeout and concurrency limits.
 */
export async function estimateWalking(from: LatLng, to: LatLng) {
  const route = await liveWalkingRoute(from, to);
  return { durationSeconds: route.durationSeconds, distanceMeters: route.distanceMeters };
}
