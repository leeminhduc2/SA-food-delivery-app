/**
 * Pure delivery-domain rules. No database, HTTP or provider code lives here.
 */

export type LatLng = { latitude: number; longitude: number };

export type ShippingConfig = {
  baseDistanceMeters: number;
  baseFee: number;
  perExtraKilometreFee: number;
  maxDistanceMeters: number;
  currency: string;
};

export const DEFAULT_SHIPPING_CONFIG: ShippingConfig = {
  baseDistanceMeters: 2_000,
  baseFee: 10_000,
  perExtraKilometreFee: 3_000,
  maxDistanceMeters: 15_000,
  currency: 'VND',
};

export type ShippingQuote =
  | {
      supported: true;
      distanceMeters: number;
      extraKilometres: number;
      shippingFee: number;
      currency: string;
    }
  | {
      supported: false;
      distanceMeters: number;
      shippingFee: null;
      reason: 'INVALID_DISTANCE' | 'OUT_OF_RANGE';
    };

export function isValidCoordinate(latitude: unknown, longitude: unknown): boolean {
  return (
    typeof latitude === 'number' &&
    typeof longitude === 'number' &&
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/**
 * Demo shipping policy:
 *   0–2 km: 10,000 VND
 *   each started km above 2 km: +3,000 VND
 *   over 15 km: unsupported
 *
 * The distance used by callers must come from the pedestrian router. This
 * function must never be fed a straight-line/Haversine estimate.
 */
export function shippingQuote(
  distanceMeters: number,
  config: ShippingConfig = DEFAULT_SHIPPING_CONFIG,
): ShippingQuote {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    return {
      supported: false,
      distanceMeters: 0,
      shippingFee: null,
      reason: 'INVALID_DISTANCE',
    };
  }
  const roundedDistance = Math.round(distanceMeters);
  if (roundedDistance > config.maxDistanceMeters) {
    return {
      supported: false,
      distanceMeters: roundedDistance,
      shippingFee: null,
      reason: 'OUT_OF_RANGE',
    };
  }
  const extraKilometres = Math.max(
    0,
    Math.ceil((roundedDistance - config.baseDistanceMeters) / 1_000),
  );
  return {
    supported: true,
    distanceMeters: roundedDistance,
    extraKilometres,
    shippingFee: config.baseFee + extraKilometres * config.perExtraKilometreFee,
    currency: config.currency,
  };
}

/** Only used to reject impossible coordinates early, never as a displayed distance. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const radius = 6_371_000;
  const radians = (value: number) => (value * Math.PI) / 180;
  const dLat = radians(b.latitude - a.latitude);
  const dLon = radians(b.longitude - a.longitude);
  const lat1 = radians(a.latitude);
  const lat2 = radians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * radius * Math.asin(Math.sqrt(h)));
}

export type RouteGeometry = {
  type: 'LineString';
  coordinates: [number, number][];
};

export type WalkingRoute = {
  distanceMeters: number;
  durationSeconds: number;
  routeGeometry: RouteGeometry;
  provider: string;
};
