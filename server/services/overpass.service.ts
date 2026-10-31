import { DEFAULT_HANOI_BBOX, parseBBox, type BBox } from '../domain/osm.js';

export type OverpassFetch = (input: string, init?: RequestInit) => Promise<Response>;
export type OverpassDeps = {
  fetchImpl?: OverpassFetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

export type OverpassOptions = {
  bbox?: BBox;
  endpoint?: string;
  timeoutMs?: number;
  retries?: number;
  retryBaseMs?: number;
  maxElements?: number;
};

export type OverpassResult = {
  elements: unknown[];
  endpoint: string;
  bbox: BBox;
  fetchedAt: string;
};

export class OverpassError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly attempts: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'OverpassError';
  }
}

export const DEFAULT_OVERPASS_ENDPOINT = 'https://overpass-api.de/api/interpreter';

export function overpassEndpoint(): string {
  return process.env.OVERPASS_ENDPOINT || DEFAULT_OVERPASS_ENDPOINT;
}

export function overpassBBox(): BBox {
  return process.env.OVERPASS_HANOI_BBOX
    ? parseBBox(process.env.OVERPASS_HANOI_BBOX)
    : DEFAULT_HANOI_BBOX;
}

export function overpassTimeout(): number {
  const value = Number(process.env.OVERPASS_TIMEOUT_MS || 30000);
  return Number.isFinite(value) && value > 0 ? Math.min(value, 120000) : 30000;
}

export function overpassRetries(): number {
  const value = Number(process.env.OVERPASS_RETRIES ?? 3);
  return Number.isInteger(value) && value >= 0 ? Math.min(value, 5) : 3;
}

export function overpassMaxElements(): number {
  const value = Number(process.env.OVERPASS_MAX_ELEMENTS || 2000);
  return Number.isInteger(value) && value > 0 ? Math.min(value, 10000) : 2000;
}

/** Query nodes, ways and relations; `out center` provides coordinates for ways/relations. */
export function buildOverpassQuery(bbox: BBox, timeoutMs: number): string {
  const box = bbox.join(',');
  const timeout = Math.max(1, Math.ceil(timeoutMs / 1000));
  return `[out:json][timeout:${timeout}];(node["amenity"~"^(restaurant|fast_food|food_court)$"](${box});way["amenity"~"^(restaurant|fast_food|food_court)$"](${box});relation["amenity"~"^(restaurant|fast_food|food_court)$"](${box}););out center;`;
}

const inFlight = new Map<string, Promise<OverpassResult>>();

const defaultSleep = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function isAbort(error: unknown): boolean {
  return (
    (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
    (error instanceof Error && /aborted|timeout/i.test(error.message))
  );
}

function retryAfterMs(response: Response | undefined): number | null {
  const header = response?.headers?.get?.('retry-after');
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30000);
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.min(Math.max(date - Date.now(), 0), 30000) : null;
}

/**
 * Fetch OSM establishments for one bounding box.
 *
 * - POSTs the Overpass QL body, with an identifying User-Agent.
 * - Aborts after `timeoutMs` and retries transient failures (network, 429, 5xx)
 *   with exponential backoff.
 * - Coalesces identical concurrent requests so the public endpoint is not
 *   hammered by overlapping imports.
 */
export async function fetchOsmRestaurants(
  options: OverpassOptions = {},
  deps: OverpassDeps = {},
): Promise<OverpassResult> {
  const bbox = options.bbox ?? overpassBBox();
  const endpoint = options.endpoint ?? overpassEndpoint();
  const timeoutMs = options.timeoutMs ?? overpassTimeout();
  const retries = options.retries ?? overpassRetries();
  const retryBaseMs = options.retryBaseMs ?? 1000;
  const maxElements = options.maxElements ?? overpassMaxElements();
  const fetchImpl = deps.fetchImpl ?? (fetch as OverpassFetch);
  const sleep = deps.sleep ?? defaultSleep;
  const query = buildOverpassQuery(bbox, timeoutMs);
  const key = `${endpoint}|${query}`;

  const existing = inFlight.get(key);
  if (existing) return existing;

  const run = (async (): Promise<OverpassResult> => {
    let lastError: OverpassError | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let response: Response | undefined;
      try {
        response = await fetchImpl(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': 'BepFoodDelivery/1.0 (restaurant import; admin@bep.local)',
          },
          body: new URLSearchParams({ data: query }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const retryable = response.status === 429 || response.status >= 500;
          lastError = new OverpassError(
            `Overpass responded with HTTP ${response.status}.`,
            response.status === 429 ? 'RATE_LIMITED' : `HTTP_${response.status}`,
            attempt + 1,
            retryable,
          );
          if (!retryable) throw lastError;
        } else {
          const data = (await response.json()) as { elements?: unknown; remark?: unknown };
          if (!data || !Array.isArray(data.elements))
            throw new OverpassError(
              'Overpass returned an invalid JSON shape.',
              'INVALID_RESPONSE',
              attempt + 1,
              false,
            );
          if (typeof data.remark === 'string' && data.elements.length === 0)
            throw new OverpassError(
              `Overpass remark: ${data.remark}`,
              'OVERPASS_REMARK',
              attempt + 1,
              true,
            );
          if (data.elements.length > maxElements)
            throw new OverpassError(
              `Overpass returned ${data.elements.length} elements, above the ${maxElements} limit.`,
              'TOO_MANY_ELEMENTS',
              attempt + 1,
              false,
            );
          return {
            elements: data.elements,
            endpoint,
            bbox,
            fetchedAt: new Date().toISOString(),
          };
        }
      } catch (error) {
        if (error instanceof OverpassError) {
          lastError = error;
          if (!error.retryable) throw error;
        } else if (isAbort(error)) {
          lastError = new OverpassError(
            `Overpass request timed out after ${timeoutMs}ms.`,
            'TIMEOUT',
            attempt + 1,
            true,
          );
        } else {
          lastError = new OverpassError(
            error instanceof Error ? error.message : 'Overpass request failed.',
            'NETWORK_ERROR',
            attempt + 1,
            true,
          );
        }
      } finally {
        clearTimeout(timer);
      }
      if (attempt < retries) {
        const retryAfter = retryAfterMs(response);
        const backoff = retryBaseMs * 2 ** attempt;
        await sleep(Math.max(retryAfter ?? 0, backoff));
      }
    }
    throw lastError ?? new OverpassError('Overpass request failed.', 'UNKNOWN', retries + 1, false);
  })();

  inFlight.set(key, run);
  try {
    return await run;
  } finally {
    inFlight.delete(key);
  }
}
