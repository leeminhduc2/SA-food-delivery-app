import { z } from 'zod';
import { dbNow, prisma, transaction } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import { publish } from '../../../shared/events.js';
import { lockActiveDriver, lockDriver } from '../../identity/index.js';
import { trackingTransport } from '../../notification/index.js';
import { locationDependencies } from '../driver-location.ports.js';
import { validateLocationTime } from '../domain/driver-location-policy.js';

const locationInput = z.object({
  latitude: z.number().finite().min(-90).max(90),
  longitude: z.number().finite().min(-180).max(180),
  capturedAt: z.string().datetime({ offset: true }),
});
export async function recordDriverLocation(driverId: string, raw: unknown) {
  const input = locationInput.parse(raw);
  const { policy } = locationDependencies();
  const location = await transaction(async (db) => {
    check(
      await lockActiveDriver(driverId, db),
      403,
      'FORBIDDEN',
      'An active driver account is required.',
    );
    const now = await dbNow(db);
    const capturedAt = new Date(input.capturedAt);
    const previous = await db.driverLocation.findUnique({ where: { driver_id: driverId } });
    const failure = validateLocationTime(capturedAt, now, previous, policy);
    if (failure)
      check(
        false,
        failure === 'LOCATION_RATE_LIMITED' ? 429 : 409,
        failure,
        'Location update was rejected; try again with a current position.',
      );
    const row = await db.driverLocation.upsert({
      where: { driver_id: driverId },
      create: {
        driver_id: driverId,
        latitude: input.latitude,
        longitude: input.longitude,
        captured_at: capturedAt,
        received_at: now,
      },
      update: {
        latitude: input.latitude,
        longitude: input.longitude,
        captured_at: capturedAt,
        received_at: now,
        version: { increment: 1 },
      },
    });
    await publish(db, 'DriverOperationalStateChanged', {
      driverId,
      source: 'LOCATION',
      reason: 'LOCATION_CHANGED',
      observedVersion: row.version,
    });
    return row;
  });
  const transport = trackingTransport();
  if (transport) {
    // The DB transaction has committed. Redis is an ephemeral hint and must
    // never fail or delay an accepted location update.
    void transport
      .publishLocation(
        {
          driverId,
          latitude: location.latitude,
          longitude: location.longitude,
          capturedAt: location.captured_at.toISOString(),
          receivedAt: location.received_at.toISOString(),
          version: location.version,
        },
        locationDependencies().trackingTtlSeconds,
      )
      .catch(() => undefined);
  }
  return {
    capturedAt: location.captured_at,
    receivedAt: location.received_at,
    version: location.version,
  };
}
export async function purgeStaleDriverLocations() {
  const { policy, retain } = locationDependencies();
  const now = await dbNow();
  const cutoff = new Date(now.getTime() - policy.retentionSeconds * 1000);
  const candidates = await prisma.driverLocation.findMany({
    where: { received_at: { lt: cutoff } },
    select: { driver_id: true },
    take: 100,
  });
  for (const candidate of candidates)
    await transaction(async (db) => {
      if (!(await lockDriver(candidate.driver_id, db))) return;
      const currentNow = await dbNow(db);
      if (await retain(candidate.driver_id, currentNow, db)) return;
      await db.driverLocation.deleteMany({
        where: {
          driver_id: candidate.driver_id,
          received_at: { lt: new Date(currentNow.getTime() - policy.retentionSeconds * 1000) },
        },
      });
    });
}
