import { id, lockRow, prisma, type DB } from '../../../shared/db.js';

export type DeliveryRow = {
  id: string;
  order_id: string;
  driver_id: string | null;
  status: string;
  updated_at: Date | string;
};

export async function insert(orderId: string, db: DB = prisma): Promise<void> {
  await db.delivery.create({ data: { id: id(), order_id: orderId } });
}

export async function findByOrderForUpdate(
  orderId: string,
  db: DB = prisma,
): Promise<DeliveryRow | undefined> {
  await lockRow(db, 'deliveries', 'order_id', orderId);
  return (
    ((await db.delivery.findUnique({ where: { order_id: orderId } })) as DeliveryRow | null) ??
    undefined
  );
}

export async function findById(
  deliveryId: string,
  db: DB = prisma,
): Promise<DeliveryRow | undefined> {
  return (
    ((await db.delivery.findUnique({ where: { id: deliveryId } })) as DeliveryRow | null) ??
    undefined
  );
}

export async function findForUpdate(
  deliveryId: string,
  db: DB = prisma,
): Promise<DeliveryRow | undefined> {
  await lockRow(db, 'deliveries', 'id', deliveryId);
  return findById(deliveryId, db);
}

export async function findOrderId(
  deliveryId: string,
  db: DB = prisma,
): Promise<{ order_id: string } | undefined> {
  return (
    (await db.delivery.findUnique({
      where: { id: deliveryId },
      select: { order_id: true },
    })) ?? undefined
  );
}

export async function setStatus(
  deliveryId: string,
  status: string,
  db: DB = prisma,
): Promise<void> {
  const now = new Date();
  await db.delivery.updateMany({
    where: { id: deliveryId },
    data: {
      status,
      updated_at: now,
      ...(status === 'PICKED_UP' ? { picked_up_at: now } : {}),
      ...(status === 'IN_TRANSIT' ? { in_transit_at: now } : {}),
      ...(status === 'DELIVERED' ? { delivered_at: now } : {}),
      ...(status === 'FAILED' ? { failed_at: now } : {}),
    },
  });
}

export async function assign(deliveryId: string, driverId: string, db: DB = prisma): Promise<void> {
  await db.delivery.updateMany({
    where: { id: deliveryId },
    data: { driver_id: driverId, status: 'ASSIGNED', updated_at: new Date() },
  });
}

export async function deactivateAssignments(
  deliveryId: string,
  reason: string,
  db: DB = prisma,
): Promise<void> {
  await db.driverAssignment.updateMany({
    where: { delivery_id: deliveryId, active: true },
    data: { active: false, ended_at: new Date(), end_reason: reason },
  });
}

export async function findActiveForDriver(
  driverId: string,
  db: DB,
): Promise<{ id: string } | undefined> {
  return (
    (await db.driverAssignment.findFirst({
      where: { driver_id: driverId, active: true },
      select: { id: true },
    })) ?? undefined
  );
}

export async function busyDriverIds(ids: readonly string[], db: DB = prisma): Promise<string[]> {
  const rows = await db.driverAssignment.findMany({
    where: { driver_id: { in: [...ids] }, active: true },
    select: { driver_id: true },
  });
  return rows.map((row) => row.driver_id);
}

export async function insertAssignment(
  deliveryId: string,
  driverId: string,
  db: DB = prisma,
): Promise<void> {
  await db.driverAssignment.create({
    data: { id: id(), delivery_id: deliveryId, driver_id: driverId },
  });
}

export async function findActiveAssignment(
  deliveryId: string,
  driverId: string,
  db: DB = prisma,
): Promise<{ id: string } | undefined> {
  return (
    (await db.driverAssignment.findFirst({
      where: { delivery_id: deliveryId, driver_id: driverId, active: true },
      select: { id: true },
    })) ?? undefined
  );
}

/** The delivery for an order that this driver currently holds an active assignment on. */
export async function findActiveForOrderAndDriver(
  orderId: string,
  driverId: string,
  db: DB = prisma,
): Promise<{ id: string } | undefined> {
  return (
    (await db.delivery.findFirst({
      where: {
        order_id: orderId,
        OR: [
          { assignments: { some: { driver_id: driverId, active: true } } },
          {
            driver_id: driverId,
            status: { in: ['DELIVERED', 'FAILED', 'CANCELLED'] },
            assignments: {
              some: {
                driver_id: driverId,
                end_reason: { in: ['DELIVERED', 'FAILED', 'CANCELLED', 'MIGRATION_TERMINAL'] },
              },
            },
          },
        ],
      },
      select: { id: true },
    })) ?? undefined
  );
}
