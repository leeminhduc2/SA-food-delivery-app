import { id, lockRow, prisma, type DB } from '../../../shared/db.js';

export type DeliveryRow = {
  id: string;
  order_id: string;
  driver_id: string | null;
  status: string;
  arrived_at: Date | null;
  proof_required: boolean;
  updated_at: Date | string;
};

export async function insert(
  orderId: string,
  proofRequired: boolean,
  db: DB = prisma,
): Promise<void> {
  await db.delivery.create({
    data: { id: id(), order_id: orderId, proof_required: proofRequired },
  });
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

export async function trackingDeliveryForOrder(orderId: string, db: DB = prisma) {
  return db.delivery.findUnique({
    where: { order_id: orderId },
    select: {
      id: true,
      status: true,
      driver_id: true,
      assignments: { where: { active: true }, select: { id: true, driver_id: true }, take: 1 },
    },
  });
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

export async function markArrived(
  deliveryId: string,
  driverId: string,
  db: DB,
): Promise<Date | null> {
  const rows = await db.$queryRaw<Array<{ arrived_at: Date }>>`
    UPDATE deliveries SET arrived_at = clock_timestamp(), updated_at = clock_timestamp()
    WHERE id = ${deliveryId} AND driver_id = ${driverId} AND status = 'ASSIGNED' AND arrived_at IS NULL
    RETURNING arrived_at`;
  return rows[0]?.arrived_at ?? null;
}

export async function assign(deliveryId: string, driverId: string, db: DB = prisma): Promise<void> {
  await db.delivery.updateMany({
    where: { id: deliveryId },
    data: { driver_id: driverId, status: 'ASSIGNED', arrived_at: null, updated_at: new Date() },
  });
}

export async function unassign(deliveryId: string, db: DB): Promise<void> {
  await db.delivery.update({
    where: { id: deliveryId },
    data: { driver_id: null, status: 'UNASSIGNED', arrived_at: null, updated_at: new Date() },
  });
}

export async function findActiveDeliveryForDriver(driverId: string, db: DB) {
  return db.driverAssignment.findFirst({
    where: { driver_id: driverId, active: true },
    select: { delivery_id: true },
  });
}

export async function listUnassignedForBootstrap(after: string | undefined, limit: number, db: DB) {
  return db.delivery.findMany({
    where: { status: 'UNASSIGNED', driver_id: null, ...(after ? { id: { gt: after } } : {}) },
    select: { id: true, order_id: true },
    orderBy: { id: 'asc' },
    take: limit,
  });
}

export async function listActiveAssignmentsForBootstrap(
  after: string | undefined,
  limit: number,
  db: DB,
) {
  return db.driverAssignment.findMany({
    where: { active: true, ...(after ? { id: { gt: after } } : {}) },
    select: { id: true, driver_id: true },
    orderBy: { id: 'asc' },
    take: limit,
  });
}

/**
 * Opens one incident per delivery and type while it is OPEN. Returns the new ID,
 * or null when an open incident of that type already exists (duplicate event).
 */
export async function openIncident(
  incident: { deliveryId: string; orderId: string; type: string; reason: string; actorId: string },
  db: DB,
): Promise<string | null> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    INSERT INTO delivery_incidents (id, delivery_id, order_id, type, reason, actor_id)
    VALUES (${id()}, ${incident.deliveryId}, ${incident.orderId}, ${incident.type}, ${incident.reason}, ${incident.actorId})
    ON CONFLICT (delivery_id, type) WHERE status = 'OPEN' DO NOTHING
    RETURNING id`;
  if (!rows.length) return null;
  await db.deliveryIncidentHistory.create({
    data: {
      id: id(),
      incident_id: rows[0].id,
      action: 'OPENED',
      actor_id: incident.actorId,
      reason: incident.reason,
    },
  });
  return rows[0].id;
}

export async function insertOperationalIncident(
  deliveryId: string,
  orderId: string,
  reason: string,
  db: DB,
) {
  const opened = await openIncident(
    { deliveryId, orderId, type: 'DRIVER_UNAVAILABLE', reason, actorId: 'system' },
    db,
  );
  return opened !== null;
}

export async function insertFailureIncident(
  deliveryId: string,
  orderId: string,
  reason: string,
  db: DB,
  actorId = 'system',
) {
  return openIncident({ deliveryId, orderId, type: 'DELIVERY_FAILED', reason, actorId }, db);
}

export async function insertOverrideIncident(
  deliveryId: string,
  orderId: string,
  reason: string,
  db: DB,
) {
  return openIncident(
    { deliveryId, orderId, type: 'ADMIN_OVERRIDE', reason, actorId: 'system' },
    db,
  );
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
): Promise<string> {
  const row = await db.driverAssignment.create({
    data: { id: id(), delivery_id: deliveryId, driver_id: driverId },
  });
  return row.id;
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
