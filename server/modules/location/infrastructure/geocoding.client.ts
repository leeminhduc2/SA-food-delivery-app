import { isValidCoordinate } from '../domain/geo.js';

export type GeocodeResult = {
  address: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
  provider: string;
};

export type GeocodingProvider = {
  name: string;
  search(query: string): Promise<GeocodeResult | null>;
  reverse(latitude: number, longitude: number): Promise<GeocodeResult | null>;
};

export class GeocodingProviderError extends Error {
  constructor(
    public readonly code: 'TIMEOUT' | 'PROVIDER_ERROR' | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(message);
  }
}

const numberFrom = (value: unknown): number | undefined => {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : undefined;
};

async function requestJson(url: URL, timeoutMs: number, userAgent: string): Promise<any> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { Accept: 'application/json', 'User-Agent': userAgent },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError')
      throw new GeocodingProviderError('TIMEOUT', 'The geocoding service took too long.');
    throw new GeocodingProviderError('PROVIDER_ERROR', 'The geocoding service is unavailable.');
  }
  if (!response.ok)
    throw new GeocodingProviderError(
      'PROVIDER_ERROR',
      `The geocoding service returned ${response.status}.`,
    );
  try {
    return await response.json();
  } catch {
    throw new GeocodingProviderError(
      'INVALID_RESPONSE',
      'The geocoding service returned invalid data.',
    );
  }
}

function validResult(
  provider: string,
  address: string,
  formattedAddress: string,
  latitude: unknown,
  longitude: unknown,
): GeocodeResult | null {
  const lat = numberFrom(latitude);
  const lon = numberFrom(longitude);
  if (!isValidCoordinate(lat, lon)) return null;
  return {
    address,
    formattedAddress: formattedAddress.trim() || address.trim(),
    latitude: lat as number,
    longitude: lon as number,
    provider,
  };
}

function photonLabel(properties: Record<string, unknown>): string {
  const parts = [
    [properties.housenumber, properties.street].filter(Boolean).join(' '),
    properties.name,
    properties.locality,
    properties.district,
    properties.city,
    properties.country,
  ]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .map((part) => part.trim());
  return [...new Set(parts)].join(', ');
}

export function photonProvider(options: {
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}): GeocodingProvider {
  const baseUrl = (options.baseUrl || 'https://photon.komoot.io').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 6_000;
  const userAgent = options.userAgent || 'BepFoodDelivery/1.0 (local development)';
  return {
    name: 'photon',
    async search(query) {
      const url = new URL(baseUrl + '/api');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', '5');
      url.searchParams.set('lang', 'default');
      // Bias, not a hard filter: the product currently serves Hanoi.
      url.searchParams.set('lat', '21.0285');
      url.searchParams.set('lon', '105.8542');
      const body = await requestJson(url, timeoutMs, userAgent);
      const features = Array.isArray(body?.features) ? body.features : [];
      for (const feature of features) {
        const properties = (feature?.properties || {}) as Record<string, unknown>;
        if (String(properties.countrycode || '').toUpperCase() !== 'VN') continue;
        const coordinates = feature?.geometry?.coordinates;
        if (!Array.isArray(coordinates) || coordinates.length < 2) continue;
        const label = photonLabel(properties) || String(properties.name || query);
        const result = validResult('photon', query, label, coordinates[1], coordinates[0]);
        if (result) return result;
      }
      return null;
    },
    async reverse(latitude, longitude) {
      if (!isValidCoordinate(latitude, longitude)) return null;
      const url = new URL(baseUrl + '/reverse');
      url.searchParams.set('lat', String(latitude));
      url.searchParams.set('lon', String(longitude));
      url.searchParams.set('lang', 'default');
      const body = await requestJson(url, timeoutMs, userAgent);
      const feature = Array.isArray(body?.features) ? body.features[0] : null;
      if (!feature) return null;
      const properties = (feature?.properties || {}) as Record<string, unknown>;
      if (String(properties.countrycode || '').toUpperCase() !== 'VN') return null;
      const coordinates = feature?.geometry?.coordinates;
      if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
      const label = photonLabel(properties);
      return validResult('photon', label, label, coordinates[1], coordinates[0]);
    },
  };
}

export function nominatimProvider(options: {
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}): GeocodingProvider {
  const baseUrl = (options.baseUrl || 'https://nominatim.openstreetmap.org').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 6_000;
  const userAgent = options.userAgent || 'BepFoodDelivery/1.0 (local development)';
  function resultFrom(row: any, fallback: string): GeocodeResult | null {
    if (!row) return null;
    if (row.address?.country_code && row.address.country_code !== 'vn') return null;
    return validResult(
      'nominatim',
      fallback,
      String(row.display_name || fallback),
      row.lat,
      row.lon,
    );
  }
  return {
    name: 'nominatim',
    async search(query) {
      const url = new URL(baseUrl + '/search');
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('limit', '5');
      url.searchParams.set('countrycodes', 'vn');
      url.searchParams.set('addressdetails', '1');
      url.searchParams.set('q', query);
      const body = await requestJson(url, timeoutMs, userAgent);
      if (!Array.isArray(body)) return null;
      for (const row of body) {
        const result = resultFrom(row, query);
        if (result) return result;
      }
      return null;
    },
    async reverse(latitude, longitude) {
      if (!isValidCoordinate(latitude, longitude)) return null;
      const url = new URL(baseUrl + '/reverse');
      url.searchParams.set('format', 'jsonv2');
      url.searchParams.set('lat', String(latitude));
      url.searchParams.set('lon', String(longitude));
      const body = await requestJson(url, timeoutMs, userAgent);
      return resultFrom(body, `${latitude}, ${longitude}`);
    },
  };
}

export function geocodingProviderFromEnv(env = process.env): GeocodingProvider {
  const provider = (env.GEOCODING_PROVIDER || 'photon').toLowerCase();
  const options = {
    baseUrl: env.GEOCODING_BASE_URL,
    timeoutMs: Number(env.GEOCODING_TIMEOUT_MS || 6000),
    userAgent: env.GEOCODING_USER_AGENT,
  };
  return provider === 'nominatim' ? nominatimProvider(options) : photonProvider(options);
}

/** Test seam: never used by application code. */
export let activeGeocodingProvider: GeocodingProvider = geocodingProviderFromEnv();

export function setGeocodingProvider(provider: GeocodingProvider): void {
  activeGeocodingProvider = provider;
}

export function resetGeocodingProvider(): void {
  activeGeocodingProvider = geocodingProviderFromEnv();
}
