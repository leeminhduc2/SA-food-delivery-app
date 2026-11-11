import type { Prisma } from '@prisma/client';
import type { LatLng, RouteGeometry, ShippingConfig } from '../domain/geo.js';
import * as quotes from '../infrastructure/delivery-quote.repository.js';
import type { DeliveryInfo } from './shipping.service.js';
import { shippingConfig } from './shipping.service.js';

/**
 * Persisted walking quotes.
 *
 * The pricing key fingerprints every input of the fee formula. Changing an
 * environment override makes old snapshots ineligible instead of silently
 * charging yesterday's price.
 */
export function quotePricingKey(config: ShippingConfig = shippingConfig()): string {
  return [
    'v1',
    config.baseDistanceMeters,
    config.baseFee,
    config.perExtraKilometreFee,
    config.maxDistanceMeters,
    config.currency,
  ].join(':');
}

function quoteTtlMs(): number {
  return Math.max(1, Number(process.env.DELIVERY_QUOTE_TTL_SECONDS || 3_600)) * 1_000;
}

function isStorable(info: DeliveryInfo): boolean {
  if (info.status === 'AVAILABLE')
    return (
      info.distanceMeters !== null && info.durationSeconds !== null && info.shippingFee !== null
    );
  // NO_WALKING_ROUTE and provider failures can be transient; only the
  // deterministic out-of-range outcome is safe to remember.
  return info.status === 'UNSUPPORTED' && info.reason === 'OUT_OF_RANGE';
}

/**
 * A stored quote is valid only when it describes this exact address, this
 * exact restaurant position and the current fee formula.
 */
export async function cachedDeliveryInfo(
  addressId: string,
  address: LatLng,
  restaurantId: string,
  destination: LatLng,
  options: { includeGeometry?: boolean; config?: ShippingConfig } = {},
): Promise<DeliveryInfo | null> {
  const config = options.config ?? shippingConfig();
  const row = await quotes.findOne(addressId, restaurantId);
  if (!row) return null;
  if (row.pricing_key !== quotePricingKey(config)) return null;
  if (new Date(row.expires_at).getTime() <= Date.now()) return null;
  if (row.status !== 'AVAILABLE' && row.status !== 'UNSUPPORTED') return null;
  if (row.status === 'UNSUPPORTED' && row.reason !== 'OUT_OF_RANGE') return null;
  // Coordinates are part of the key: a moved restaurant or edited address
  // invalidates rather than rebrands an old route.
  if (row.address_latitude !== address.latitude || row.address_longitude !== address.longitude)
    return null;
  if (
    row.restaurant_latitude !== destination.latitude ||
    row.restaurant_longitude !== destination.longitude
  )
    return null;
  return {
    status: row.status,
    supported: row.status === 'AVAILABLE',
    distanceMeters: row.distance_meters,
    durationSeconds: row.duration_seconds,
    shippingFee: row.shipping_fee,
    currency: row.currency,
    reason: row.reason,
    ...(options.includeGeometry && row.route_geometry
      ? { routeGeometry: row.route_geometry as unknown as RouteGeometry }
      : {}),
  };
}

/** Store only deterministic outcomes; transient failures must be retried. */
export async function rememberDeliveryInfo(
  addressId: string,
  address: LatLng,
  restaurantId: string,
  destination: LatLng,
  info: DeliveryInfo,
  config: ShippingConfig = shippingConfig(),
): Promise<void> {
  if (!isStorable(info)) return;
  await quotes.upsert({
    addressId,
    restaurantId,
    status: info.status as 'AVAILABLE' | 'UNSUPPORTED',
    reason: info.reason,
    distanceMeters: info.distanceMeters,
    durationSeconds: info.durationSeconds,
    shippingFee: info.shippingFee,
    currency: info.currency,
    routeGeometry: (info.routeGeometry ?? null) as Prisma.InputJsonValue | null,
    addressLatitude: address.latitude,
    addressLongitude: address.longitude,
    restaurantLatitude: destination.latitude,
    restaurantLongitude: destination.longitude,
    pricingKey: quotePricingKey(config),
    expiresAt: new Date(Date.now() + quoteTtlMs()),
  });
}

export async function forgetRestaurantQuotes(restaurantId: string): Promise<void> {
  await quotes.deleteForRestaurant(restaurantId);
}

export async function forgetAddressQuotes(addressId: string): Promise<void> {
  await quotes.deleteForAddress(addressId);
}
