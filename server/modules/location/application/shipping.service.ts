import {
  DEFAULT_SHIPPING_CONFIG,
  isValidCoordinate,
  shippingQuote,
  type LatLng,
  type RouteGeometry,
  type ShippingConfig,
} from '../domain/geo.js';
import { GeocodingProviderError } from '../infrastructure/geocoding.client.js';
import { RoutingProviderError } from '../infrastructure/routing.client.js';
import * as restaurants from '../../catalog/infrastructure/restaurant.repository.js';
import type { RestaurantRow } from '../../catalog/infrastructure/restaurant.repository.js';
import { defaultAddressFor, type DeliveryAddress } from './address.service.js';
import { geocodeAddress } from './geocoding.service.js';
import { walkingRoute } from './routing.service.js';

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

function unavailable(reason: string): DeliveryInfo {
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

async function restaurantCoordinates(
  restaurant: RestaurantRow,
): Promise<LatLng | null | 'GEOCODING_FAILED'> {
  if (isValidCoordinate(restaurant.latitude, restaurant.longitude))
    return { latitude: restaurant.latitude as number, longitude: restaurant.longitude as number };
  if (!restaurant.address || restaurant.address.trim().length < 5) return null;
  try {
    const found = await geocodeAddress(restaurant.address);
    if (!found) return null;
    await restaurants.setCoordinates(
      restaurant.id,
      restaurant.address,
      found.latitude,
      found.longitude,
    );
    return { latitude: found.latitude, longitude: found.longitude };
  } catch (error) {
    if (error instanceof GeocodingProviderError) return 'GEOCODING_FAILED';
    throw error;
  }
}

export async function deliveryInfoForRestaurant(
  restaurant: RestaurantRow,
  address: DeliveryAddress | null,
  options: { includeGeometry?: boolean; config?: ShippingConfig } = {},
): Promise<DeliveryInfo> {
  if (!address) return noAddressInfo();
  const destination = await restaurantCoordinates(restaurant);
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

export async function deliveryInfoForRestaurantId(
  restaurantId: string,
  address: DeliveryAddress | null,
  options: { includeGeometry?: boolean; config?: ShippingConfig } = {},
): Promise<DeliveryInfo> {
  const restaurant = await restaurants.findById(restaurantId);
  if (!restaurant) return unavailable('RESTAURANT_NOT_FOUND');
  return deliveryInfoForRestaurant(restaurant, address, options);
}

/** Used by checkout, which must never trust a client-supplied fee. */
export async function checkoutDeliveryQuote(
  restaurantId: string,
  address: DeliveryAddress,
): Promise<{ info: DeliveryInfo; restaurant: RestaurantRow }> {
  const restaurant = await restaurants.findById(restaurantId);
  if (!restaurant) throw new Error('Restaurant disappeared during checkout.');
  const info = await deliveryInfoForRestaurant(restaurant, address, { includeGeometry: true });
  return { info, restaurant };
}
