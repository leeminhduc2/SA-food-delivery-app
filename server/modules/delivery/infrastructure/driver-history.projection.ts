import { prisma } from '../../../shared/db.js';

// Read-only cross-module projection: exposes only pickup name and assignment metadata.
export async function driverHistory(driverId: string, limit: number, cursorId?: string) {
  if (cursorId) {
    const cursor = await prisma.driverAssignment.findFirst({
      where: { id: cursorId, driver_id: driverId },
      select: { id: true },
    });
    if (!cursor) return null;
  }
  const rows = await prisma.driverAssignment.findMany({
    where: { driver_id: driverId },
    orderBy: [{ assigned_at: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
    select: {
      id: true,
      delivery_id: true,
      driver_id: true,
      active: true,
      assigned_at: true,
      ended_at: true,
      end_reason: true,
      delivery: {
        select: {
          driver_id: true,
          status: true,
          order: { select: { restaurant: { select: { name: true } } } },
        },
      },
    },
  });
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return {
    items: page.map((row) => {
      const finalDriver =
        row.delivery.driver_id === driverId &&
        ['DELIVERED', 'FAILED', 'CANCELLED'].includes(row.delivery.status) &&
        ['DELIVERED', 'FAILED', 'CANCELLED', 'MIGRATION_TERMINAL'].includes(row.end_reason || '');
      return {
        assignmentId: row.id,
        deliveryId: row.delivery_id,
        restaurantName: row.delivery.order.restaurant.name,
        assignedAt: row.assigned_at,
        endedAt: row.ended_at,
        result: row.active
          ? 'ACTIVE'
          : finalDriver
            ? row.delivery.status
            : row.end_reason || 'ENDED',
        finalDriver,
      };
    }),
    nextCursor: hasMore ? Buffer.from(page[page.length - 1].id).toString('base64url') : null,
  };
}
