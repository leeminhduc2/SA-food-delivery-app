import { prisma, type DB } from '../../../shared/db.js';
export async function latestDriverLocation(driverId: string, db: DB = prisma) {
  return db.driverLocation.findUnique({ where: { driver_id: driverId } });
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
