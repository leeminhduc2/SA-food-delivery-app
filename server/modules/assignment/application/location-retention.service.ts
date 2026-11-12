import type { DB } from '../../../shared/db.js';
import { hasActiveTrip } from '../../delivery/index.js';
import { assignmentConfig } from '../config.js';
export async function retainDriverLocation(driverId: string, now: Date, db: DB): Promise<boolean> {
  if (await hasActiveTrip(driverId, db)) return true;
  const row = await db.driverAvailability.findUnique({ where: { driver_id: driverId } });
  return Boolean(
    row?.online &&
    row.heartbeat_at &&
    now.getTime() - row.heartbeat_at.getTime() <
      assignmentConfig.OFFLINE_LOCATION_RETENTION_SECONDS * 1000,
  );
}
