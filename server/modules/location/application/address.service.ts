import { z } from 'zod';
import { check } from '../../../shared/errors.js';
import { isValidCoordinate, type LatLng } from '../domain/geo.js';
import type { User } from '../../../shared/types.js';
import * as addresses from '../infrastructure/address.repository.js';
import { emitAddressSaved } from './address-events.js';
import { GeocodingProviderError, geocodeAddress, reverseGeocode } from './geocoding.service.js';

const coordinates = {
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
};

const saveSchema = z
  .object({
    address: z.string().trim().min(5).max(300),
    ...coordinates,
  })
  .refine(
    (value) =>
      (value.latitude === undefined && value.longitude === undefined) ||
      (value.latitude !== undefined && value.longitude !== undefined),
    'Latitude and longitude must be supplied together.',
  );

const resolveSchema = z.union([
  z.object({ address: z.string().trim().min(5).max(300) }),
  z.object({ latitude: z.number().min(-90).max(90), longitude: z.number().min(-180).max(180) }),
]);

function providerFailure(error: unknown): never {
  if (error instanceof GeocodingProviderError) {
    check(false, 502, 'GEOCODING_' + error.code, error.message);
  }
  throw error;
}

async function resolve(
  input: { address: string } | { latitude: number; longitude: number },
): Promise<{
  address: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
}> {
  if ('latitude' in input) {
    check(
      isValidCoordinate(input.latitude, input.longitude),
      400,
      'INVALID_COORDINATES',
      'Choose a valid point on the map.',
    );
    try {
      const reversed = await reverseGeocode(input.latitude, input.longitude);
      return {
        address: reversed?.formattedAddress || `${input.latitude}, ${input.longitude}`,
        formattedAddress:
          reversed?.formattedAddress ||
          `${input.latitude.toFixed(6)}, ${input.longitude.toFixed(6)}`,
        latitude: input.latitude,
        longitude: input.longitude,
      };
    } catch (error) {
      // A selected map point is still valid when the reverse lookup is down.
      if (error instanceof GeocodingProviderError)
        return {
          address: `${input.latitude.toFixed(6)}, ${input.longitude.toFixed(6)}`,
          formattedAddress: `${input.latitude.toFixed(6)}, ${input.longitude.toFixed(6)}`,
          latitude: input.latitude,
          longitude: input.longitude,
        };
      throw error;
    }
  }
  try {
    const found = await geocodeAddress(input.address);
    check(found, 422, 'ADDRESS_NOT_FOUND', 'We could not find that address in Vietnam.');
    return {
      address: input.address,
      formattedAddress: found.formattedAddress,
      latitude: found.latitude,
      longitude: found.longitude,
    };
  } catch (error) {
    if (error instanceof GeocodingProviderError) providerFailure(error);
    throw error;
  }
}

function publicAddress(row: addresses.AddressRow): any {
  return {
    id: row.id,
    address: row.address,
    formattedAddress: row.formatted_address,
    latitude: row.latitude,
    longitude: row.longitude,
    isDefault: row.is_default,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getDefault(actor: User): Promise<any | null> {
  const row = await addresses.findDefault(actor.id);
  return row ? publicAddress(row) : null;
}

export async function saveDefault(actor: User, raw: unknown): Promise<any> {
  const input = saveSchema.parse(raw);
  const resolved = await resolve(
    input.latitude !== undefined
      ? { latitude: input.latitude, longitude: input.longitude as number }
      : { address: input.address },
  );
  const row = await addresses.saveDefault(actor.id, {
    address: input.address,
    formattedAddress: resolved.formattedAddress,
    latitude: resolved.latitude,
    longitude: resolved.longitude,
  });
  // The save is complete only once quote snapshots for the new position exist.
  await emitAddressSaved({
    id: row.id,
    userId: actor.id,
    address: row.address,
    formattedAddress: row.formatted_address || row.address,
    latitude: row.latitude,
    longitude: row.longitude,
  });
  return publicAddress(row);
}

export async function resolveForPreview(raw: unknown): Promise<any> {
  const input = resolveSchema.parse(raw);
  try {
    const result = await resolve(input);
    return {
      address: result.address,
      formattedAddress: result.formattedAddress,
      latitude: result.latitude,
      longitude: result.longitude,
    };
  } catch (error) {
    if (error instanceof GeocodingProviderError) providerFailure(error);
    throw error;
  }
}

/** Internal: load the default address as a coordinate pair for routing. */
export async function defaultAddressFor(userId: string): Promise<DeliveryAddress | null> {
  const row = await addresses.findDefault(userId);
  if (!row) return null;
  return {
    id: row.id,
    address: row.address,
    formattedAddress: row.formatted_address || row.address,
    latitude: row.latitude,
    longitude: row.longitude,
  };
}

export type DeliveryAddress = {
  id: string;
  address: string;
  formattedAddress: string;
  latitude: number;
  longitude: number;
};

export function toLatLng(address: DeliveryAddress): LatLng {
  return { latitude: address.latitude, longitude: address.longitude };
}
