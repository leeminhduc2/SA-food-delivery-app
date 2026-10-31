import { id, lockRow, prisma, type DB } from '../db.js';

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
  await db.delivery.updateMany({
    where: { id: deliveryId },
    data: { status, updated_at: new Date() },
  });
}

export async function assign(deliveryId: string, driverId: string, db: DB = prisma): Promise<void> {
  await db.delivery.updateMany({
    where: { id: deliveryId },
    data: { driver_id: driverId, status: 'ASSIGNED', updated_at: new Date() },
  });
}

export async function deactivateAssignments(deliveryId: string, db: DB = prisma): Promise<void> {
  await db.driverAssignment.updateMany({
    where: { delivery_id: deliveryId, active: true },
    data: { active: false },
  });
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
