import { z } from 'zod';
import { dbNow, id, prisma, transaction, type DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import { lockActiveDriver } from '../../identity/index.js';
import { hasActiveTrip } from '../../delivery/index.js';
import { latestDriverLocation, locationFresh } from '../../location/index.js';
import { assignmentConfig as config } from '../config.js';

const patchSchema = z
  .object({ online: z.boolean().optional(), ready: z.boolean().optional() })
  .refine(
    (value) => value.online !== undefined || value.ready !== undefined,
    'Supply online or ready.',
  );
function heartbeatFresh(at: Date | null, now: Date) {
  return (
    at !== null && now.getTime() - at.getTime() <= config.DRIVER_HEARTBEAT_MAX_AGE_SECONDS * 1000
  );
}
async function snapshot(driverId: string, db: DB = prisma) {
  const [row, busy, location, now] = await Promise.all([
    db.driverAvailability.findUnique({ where: { driver_id: driverId } }),
    hasActiveTrip(driverId, db),
    latestDriverLocation(driverId, db),
    dbNow(db),
  ]);
  const fresh = locationFresh(
    location,
    now,
    config.DRIVER_LOCATION_MAX_AGE_SECONDS,
    config.DRIVER_LOCATION_MAX_FUTURE_SECONDS,
  );
  return {
    online: row?.online ?? false,
    ready: row?.ready ?? false,
    busy,
    heartbeatAt: row?.heartbeat_at ?? null,
    heartbeatFresh: heartbeatFresh(row?.heartbeat_at ?? null, now),
    locationFresh: fresh,
    version: row?.version ?? 0,
  };
}
export async function getAvailability(driverId: string) {
  return snapshot(driverId);
}
export async function updateAvailability(driverId: string, raw: unknown) {
  const input = patchSchema.parse(raw);
  return transaction(async (db) => {
    check(
      await lockActiveDriver(driverId, db),
      403,
      'FORBIDDEN',
      'An active driver account is required.',
    );
    const current = await snapshot(driverId, db);
    if (input.online === false)
      check(
        !current.busy,
        409,
        'ACTIVE_DELIVERY',
        'Finish your active delivery before going offline.',
      );
    if (input.online === true)
      check(
        current.locationFresh,
        409,
        'STALE_LOCATION',
        'Enable location and send a recent position before going online.',
      );
    const online = input.online ?? current.online;
    const ready = input.ready ?? current.ready;
    if (online === current.online && ready === current.ready) return current;
    const now = await dbNow(db);
    const row = await db.driverAvailability.upsert({
      where: { driver_id: driverId },
      create: { driver_id: driverId, online, ready, heartbeat_at: online ? now : null, version: 1 },
      update: {
        online,
        ready,
        heartbeat_at: online && !current.online ? now : current.heartbeatAt,
        version: { increment: 1 },
      },
    });
    await db.driverOperationalChange.create({
      data: {
        id: id(),
        driver_id: driverId,
        source: 'AVAILABILITY',
        reason: 'AVAILABILITY_CHANGED',
        observed_version: row.version,
      },
    });
    return snapshot(driverId, db);
  });
}
export async function heartbeat(driverId: string) {
  return transaction(async (db) => {
    check(
      await lockActiveDriver(driverId, db),
      403,
      'FORBIDDEN',
      'An active driver account is required.',
    );
    const current = await snapshot(driverId, db);
    check(current.online, 409, 'DRIVER_OFFLINE', 'Go online before sending a heartbeat.');
    const now = await dbNow(db);
    const row = await db.driverAvailability.update({
      where: { driver_id: driverId },
      data: { heartbeat_at: now, version: { increment: 1 } },
    });
    if (!current.heartbeatFresh)
      await db.driverOperationalChange.create({
        data: {
          id: id(),
          driver_id: driverId,
          source: 'AVAILABILITY',
          reason: 'HEARTBEAT_RESTORED',
          observed_version: row.version,
        },
      });
    return snapshot(driverId, db);
  });
}
