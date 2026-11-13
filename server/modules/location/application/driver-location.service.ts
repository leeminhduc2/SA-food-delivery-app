import { prisma, type DB } from '../../../shared/db.js';
import { trackingTransport } from '../../notification/index.js';
export async function latestDriverLocation(driverId: string, db: DB = prisma) {
  return db.driverLocation.findUnique({ where: { driver_id: driverId } });
}
/** DB identity fences stale cache entries, including rows deleted and recreated at version 1. */
export async function trackingLocationSnapshot(driverId: string, signal?: AbortSignal) {
  const current = await latestDriverLocation(driverId);
  signal?.throwIfAborted();
  if (!current) return null;
  const transport = trackingTransport();
  if (!transport) return current;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const cached = await Promise.race([
    transport.readLocation(driverId).catch(() => null),
    new Promise<null>((resolve) => {
      timeout = setTimeout(() => resolve(null), 200);
    }),
  ]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  signal?.throwIfAborted();
  if (
    !cached ||
    cached.version !== current.version ||
    cached.capturedAt !== current.captured_at.toISOString() ||
    cached.receivedAt !== current.received_at.toISOString() ||
    cached.latitude !== current.latitude ||
    cached.longitude !== current.longitude
  )
    return current;
  return { ...current, latitude: cached.latitude, longitude: cached.longitude };
}
export async function listCandidateLocations(db: DB = prisma) {
  const rows = await db.driverLocation.findMany({
    select: {
      driver_id: true,
      latitude: true,
      longitude: true,
      captured_at: true,
      received_at: true,
    },
  });
  return rows.map((row) => ({
    driverId: row.driver_id,
    latitude: row.latitude,
    longitude: row.longitude,
    capturedAt: row.captured_at,
    receivedAt: row.received_at,
  }));
}
export function locationFresh(
  location: { captured_at: Date; received_at: Date } | null,
  now: Date,
  maxAgeSeconds: number,
  maxFutureSeconds: number,
): boolean {
  if (!location) return false;
  const age = now.getTime() - location.captured_at.getTime();
  const receivedAge = now.getTime() - location.received_at.getTime();
  return (
    age <= maxAgeSeconds * 1000 &&
    age >= -maxFutureSeconds * 1000 &&
    receivedAge >= 0 &&
    receivedAge <= maxAgeSeconds * 1000
  );
}
