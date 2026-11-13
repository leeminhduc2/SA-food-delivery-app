import { prisma, transaction } from '../../../shared/db.js';
import {
  deliveryForAssignmentLocked,
  unassignedDeliveriesForBootstrap,
  activeAssignmentsForBootstrap,
} from '../../delivery/index.js';
import { assignmentOrderGateway } from '../assignment.ports.js';
import { assignmentConfig } from '../config.js';
import { createInitialSearch } from '../infrastructure/assignment.repository.js';

/** Rehearsable, idempotent cutover of existing eligible unassigned deliveries. */
export async function bootstrapAssignmentSearches(): Promise<{
  inspected: number;
  created: number;
}> {
  const gateway = assignmentOrderGateway();
  let cursor: string | undefined;
  let inspected = 0;
  let created = 0;
  for (;;) {
    const page = await unassignedDeliveriesForBootstrap(cursor, 100, prisma);
    if (!page.length) break;
    for (const candidate of page) {
      cursor = candidate.id;
      inspected++;
      const inserted = await transaction(async (db) => {
        const order = await gateway.lockOrder(candidate.order_id, db);
        const delivery = await deliveryForAssignmentLocked(candidate.id, db);
        if (
          !order ||
          !['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'].includes(order.status) ||
          !delivery ||
          delivery.order_id !== order.id ||
          delivery.status !== 'UNASSIGNED' ||
          delivery.driver_id
        )
          return false;
        const previous = await db.assignmentSearch.findFirst({
          where: { delivery_id: candidate.id },
          select: { id: true },
        });
        if (previous) return false;
        await createInitialSearch(
          candidate.id,
          assignmentConfig.ASSIGNMENT_SEARCH_DEADLINE_SECONDS,
          db,
        );
        return true;
      });
      if (inserted) created++;
    }
  }
  cursor = undefined;
  for (;;) {
    const page = await activeAssignmentsForBootstrap(cursor, 100, prisma);
    if (!page.length) break;
    for (const assignment of page) {
      cursor = assignment.id;
      await prisma.driverOperationalChange.createMany({
        data: [
          {
            id: `bootstrap:${assignment.id}`,
            driver_id: assignment.driver_id,
            source: 'BOOTSTRAP',
            reason: 'ACTIVE_ASSIGNMENT',
          },
        ],
        skipDuplicates: true,
      });
    }
  }
  return { inspected, created };
}
