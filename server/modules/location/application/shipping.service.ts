import {
  DEFAULT_SHIPPING_CONFIG,
  isValidCoordinate,
  shippingQuote,
  type LatLng,
  type RouteGeometry,
  type ShippingConfig,
} from '../domain/geo.js';
import { defaultAddressFor, type DeliveryAddress } from './address.service.js';
import { GeocodingProviderError, geocodeAddress } from './geocoding.service.js';
import { RoutingProviderError, walkingRoute } from './routing.service.js';

/** Where a place is: coordinates, unknown (null), or the geocoder was unreachable. */
export type PlaceLocation = LatLng | null | 'GEOCODING_FAILED';

export type DeliveryInfo = {
  status: 'AVAILABLE' | 'NO_ADDRESS' | 'UNSUPPORTED' | 'UNAVAILABLE';
  supported: boolean;
  distanceMeters: number | null;
  durationSeconds: number | null;
  shippingFee: number | null;
  currency: string;
  reason: string | null;
  routeGeometry?: RouteGeometry;
};

export function shippingConfig(): ShippingConfig {
  return {
    baseDistanceMeters: Number(
      process.env.SHIPPING_BASE_DISTANCE_METERS || DEFAULT_SHIPPING_CONFIG.baseDistanceMeters,
    ),
    baseFee: Number(process.env.SHIPPING_BASE_FEE || DEFAULT_SHIPPING_CONFIG.baseFee),
    perExtraKilometreFee: Number(
      process.env.SHIPPING_EXTRA_KM_FEE || DEFAULT_SHIPPING_CONFIG.perExtraKilometreFee,
    ),
    maxDistanceMeters: Number(
      process.env.SHIPPING_MAX_DISTANCE_METERS || DEFAULT_SHIPPING_CONFIG.maxDistanceMeters,
    ),
    currency: 'VND',
  };
}

export function noAddressInfo(): DeliveryInfo {
  return {
    status: 'NO_ADDRESS',
    supported: false,
    distanceMeters: null,
    durationSeconds: null,
    shippingFee: null,
    currency: 'VND',
    reason: 'NO_ADDRESS',
  };
}

export function unavailableDeliveryInfo(reason: string): DeliveryInfo {
  return {
    status: 'UNAVAILABLE',
    supported: false,
    distanceMeters: null,
    durationSeconds: null,
    shippingFee: null,
    currency: 'VND',
    reason,
  };
}
const unavailable = unavailableDeliveryInfo;

/**
 * Resolves a place's coordinates: stored ones when valid, otherwise a
 * geocoder lookup of its address. The caller decides whether to store them.
 */
export async function locatePlace(place: {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
}): Promise<PlaceLocation> {
  if (isValidCoordinate(place.latitude, place.longitude))
    return { latitude: place.latitude as number, longitude: place.longitude as number };
  if (!place.address || place.address.trim().length < 5) return null;
  try {
    const found = await geocodeAddress(place.address);
    return found ? { latitude: found.latitude, longitude: found.longitude } : null;
  } catch (error) {
    if (error instanceof GeocodingProviderError) return 'GEOCODING_FAILED';
    throw error;
  }
}

/** Walking route, distance and fee from a delivery address to a destination. */
export async function deliveryInfo(
  destination: PlaceLocation,
  address: DeliveryAddress | null,
  options: { includeGeometry?: boolean; config?: ShippingConfig } = {},
): Promise<DeliveryInfo> {
  if (!address) return noAddressInfo();
  if (destination === 'GEOCODING_FAILED') return unavailable('RESTAURANT_GEOCODING_UNAVAILABLE');
  if (!destination) return unavailable('RESTAURANT_LOCATION_UNKNOWN');
  let route;
  try {
    route = await walkingRoute(
      { latitude: address.latitude, longitude: address.longitude },
      destination,
    );
  } catch (error) {
    if (error instanceof RoutingProviderError) {
      if (error.code === 'NO_ROUTE') {
        return {
          status: 'UNSUPPORTED',
          supported: false,
          distanceMeters: null,
          durationSeconds: null,
          shippingFee: null,
          currency: 'VND',
          reason: 'NO_WALKING_ROUTE',
        };
      }
      if (error.code === 'INVALID_COORDINATES') return unavailable('INVALID_COORDINATES');
      return unavailable('ROUTE_' + error.code);
    }
    throw error;
  }
  const fee = shippingQuote(route.distanceMeters, options.config ?? shippingConfig());
  if (!fee.supported) {
    return {
      status: 'UNSUPPORTED',
      supported: false,
      distanceMeters: fee.distanceMeters,
      durationSeconds: route.durationSeconds,
      shippingFee: null,
      currency: 'VND',
      reason: fee.reason,
      ...(options.includeGeometry ? { routeGeometry: route.routeGeometry } : {}),
    };
  }
  return {
    status: 'AVAILABLE',
    supported: true,
    distanceMeters: fee.distanceMeters,
    durationSeconds: route.durationSeconds,
    shippingFee: fee.shippingFee,
    currency: fee.currency,
    reason: null,
    ...(options.includeGeometry ? { routeGeometry: route.routeGeometry } : {}),
  };
}

/** One address lookup for a batch of restaurants. */
export async function deliveryAddressForActor(
  userId: string | undefined,
): Promise<DeliveryAddress | null> {
  return userId ? defaultAddressFor(userId) : null;
}
