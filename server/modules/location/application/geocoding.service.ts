import type { GeocodeResult } from '../infrastructure/geocoding.client.js';
import { activeGeocodingProvider } from '../infrastructure/geocoding.client.js';

type CacheEntry = { value: GeocodeResult | null; expiresAt: number };

const cache = new Map<string, CacheEntry>();
const CACHE_MAX = 500;
let lastCallAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function cacheTtlMs(): number {
  return Number(process.env.GEOCODING_CACHE_TTL_SECONDS || 86_400) * 1_000;
}

function minIntervalMs(): number {
  if (process.env.GEOCODING_MIN_INTERVAL_MS !== undefined)
    return Math.max(0, Number(process.env.GEOCODING_MIN_INTERVAL_MS));
  return activeGeocodingProvider.name === 'nominatim' ? 1_100 : 300;
}

function cached(key: string): GeocodeResult | null | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.value;
}

function remember(key: string, value: GeocodeResult | null): void {
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + cacheTtlMs() });
}

function schedule<T>(work: () => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    const wait = minIntervalMs() - (Date.now() - lastCallAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastCallAt = Date.now();
    return work();
  });
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

export async function geocodeAddress(query: string): Promise<GeocodeResult | null> {
  const normalized = query.trim().replace(/\s+/g, ' ');
  if (normalized.length < 5) return null;
  const cacheKey = 'search:' + normalized.toLowerCase();
  const hit = cached(cacheKey);
  if (hit !== undefined) return hit;
  let result: GeocodeResult | null;
  try {
    result = await schedule(() => activeGeocodingProvider.search(normalized));
  } catch (error) {
    // Negative results are cached; provider failures are not, so a transient
    // outage does not poison the address for a day.
    throw error;
  }
  remember(cacheKey, result);
  return result;
}

export async function reverseGeocode(
  latitude: number,
  longitude: number,
): Promise<GeocodeResult | null> {
  const cacheKey = `reverse:${latitude.toFixed(6)},${longitude.toFixed(6)}`;
  const hit = cached(cacheKey);
  if (hit !== undefined) return hit;
  const result = await schedule(() => activeGeocodingProvider.reverse(latitude, longitude));
  remember(cacheKey, result);
  return result;
}

/** Test seam. */
export function clearGeocodingCache(): void {
  cache.clear();
  lastCallAt = 0;
  queue = Promise.resolve();
}
