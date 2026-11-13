import { resetBreaker } from '../../../shared/resilience.js';
import {
  isValidCoordinate,
  type LatLng,
  type RouteGeometry,
  type WalkingRoute,
} from '../domain/geo.js';

export type RoutingProvider = {
  name: string;
  walkingRoute(from: LatLng, to: LatLng): Promise<WalkingRoute>;
};

export class RoutingProviderError extends Error {
  constructor(
    public readonly code:
      'INVALID_COORDINATES' | 'NO_ROUTE' | 'TIMEOUT' | 'PROVIDER_ERROR' | 'INVALID_RESPONSE',
    message: string,
  ) {
    super(message);
  }
}

/** Valhalla polyline: precision 6, longitude/latitude pairs. */
export function decodePolyline(encoded: string, precision = 6): [number, number][] {
  const factor = 10 ** precision;
  const coordinates: [number, number][] = [];
  let index = 0;
  let latitude = 0;
  let longitude = 0;
  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    latitude += result & 1 ? ~(result >> 1) : result >> 1;
    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20 && index < encoded.length);
    longitude += result & 1 ? ~(result >> 1) : result >> 1;
    coordinates.push([longitude / factor, latitude / factor]);
  }
  return coordinates;
}

export function valhallaProvider(options: {
  baseUrl?: string;
  timeoutMs?: number;
  userAgent?: string;
}): RoutingProvider {
  const baseUrl = (options.baseUrl || 'https://valhalla1.openstreetmap.de').replace(/\/$/, '');
  const timeoutMs = options.timeoutMs ?? 6_000;
  const userAgent = options.userAgent || 'BepFoodDelivery/1.0 (local development)';
  return {
    name: 'valhalla-pedestrian',
    async walkingRoute(from, to) {
      if (!isValidCoordinate(from.latitude, from.longitude))
        throw new RoutingProviderError(
          'INVALID_COORDINATES',
          'The origin is not a valid coordinate.',
        );
      if (!isValidCoordinate(to.latitude, to.longitude))
        throw new RoutingProviderError(
          'INVALID_COORDINATES',
          'The restaurant location is not a valid coordinate.',
        );
      let response: Response;
      try {
        response = await fetch(baseUrl + '/route', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'User-Agent': userAgent,
          },
          body: JSON.stringify({
            locations: [
              { lat: from.latitude, lon: from.longitude },
              { lat: to.latitude, lon: to.longitude },
            ],
            costing: 'pedestrian',
            directions_options: { units: 'kilometers' },
          }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        if ((error as Error).name === 'TimeoutError' || (error as Error).name === 'AbortError')
          throw new RoutingProviderError('TIMEOUT', 'The walking router took too long.');
        throw new RoutingProviderError('PROVIDER_ERROR', 'The walking router is unavailable.');
      }
      let body: any;
      try {
        body = await response.json();
      } catch {
        throw new RoutingProviderError(
          'INVALID_RESPONSE',
          'The walking router returned invalid data.',
        );
      }
      if (!response.ok) {
        const noRoute = body?.error_code === 442 || body?.error_code === 440;
        throw new RoutingProviderError(
          noRoute ? 'NO_ROUTE' : 'PROVIDER_ERROR',
          noRoute
            ? 'No walking route is available to this address.'
            : `The walking router returned ${response.status}.`,
        );
      }
      const trip = body?.trip;
      if (!trip || trip.status !== 0 || !Array.isArray(trip.legs) || trip.legs.length === 0)
        throw new RoutingProviderError(
          'INVALID_RESPONSE',
          'The walking route response was incomplete.',
        );
      const lengthKm = Number(trip.summary?.length);
      const timeSeconds = Number(trip.summary?.time);
      if (
        !Number.isFinite(lengthKm) ||
        lengthKm < 0 ||
        !Number.isFinite(timeSeconds) ||
        timeSeconds < 0
      )
        throw new RoutingProviderError(
          'INVALID_RESPONSE',
          'The walking route distance or duration was invalid.',
        );
      const coordinates: [number, number][] = [];
      for (const leg of trip.legs) {
        if (typeof leg?.shape !== 'string')
          throw new RoutingProviderError(
            'INVALID_RESPONSE',
            'The walking route geometry was missing.',
          );
        for (const coordinate of decodePolyline(leg.shape, 6)) {
          const previous = coordinates.at(-1);
          if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1])
            coordinates.push(coordinate);
        }
      }
      if (coordinates.length < 2)
        throw new RoutingProviderError('INVALID_RESPONSE', 'The walking route geometry was empty.');
      const routeGeometry: RouteGeometry = { type: 'LineString', coordinates };
      return {
        distanceMeters: Math.round(lengthKm * 1_000),
        durationSeconds: Math.round(timeSeconds),
        routeGeometry,
        provider: 'valhalla-pedestrian',
      };
    },
  };
}

export function routingProviderFromEnv(env = process.env): RoutingProvider {
  return valhallaProvider({
    baseUrl: env.VALHALLA_BASE_URL,
    timeoutMs: Number(env.ROUTING_TIMEOUT_MS || 6000),
    userAgent: env.ROUTING_USER_AGENT,
  });
}

/** Test seam: integration tests replace the network provider with a deterministic one. */
export let activeRoutingProvider: RoutingProvider = routingProviderFromEnv();

export const ROUTING_BREAKER = 'routing-provider';

export function setRoutingProvider(provider: RoutingProvider): void {
  activeRoutingProvider = provider;
  resetBreaker(ROUTING_BREAKER);
}

export function resetRoutingProvider(): void {
  activeRoutingProvider = routingProviderFromEnv();
  resetBreaker(ROUTING_BREAKER);
}
