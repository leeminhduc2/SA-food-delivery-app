import { id, prisma, transaction, type DB } from '../../../shared/db.js';
import {
  deliveryForAssignmentLocked,
  unassignedDeliveriesForBootstrap,
} from '../../delivery/index.js';
import { activeDriverIds } from '../../identity/index.js';
import { latestDriverLocation } from '../../location/index.js';
import { assignmentOrderGateway } from '../assignment.ports.js';
import { assignmentConfig as config } from '../config.js';
import { haversineMeters, type Point } from '../domain/assignment-strategy.js';
import { availabilityInTransaction } from './availability.service.js';

const ASSIGNABLE_ORDER_STATUSES = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'];
const LIVE_SEARCH_STATUSES = ['WAITING', 'SEARCHING', 'OFFERED'];

/**
 * Only a search that ended without ever offering the work is reopened. Once a
 * driver has seen (and possibly declined or ignored) an offer, continuing the
 * rotation is an operator decision, not something a location update should
 * restart indefinitely.
 */
function reopenable(latest: { status: string; offers_created: number } | null): boolean {
  return !latest || (latest.status === 'EXHAUSTED' && latest.offers_created === 0);
}

/**
 * Opens the next search generation for one waiting delivery. The delivery and
 * order are locked and revalidated, so a driver arriving at the same moment as
 * an assignment cannot create a second live search.
 */
async function reopenDelivery(
  deliveryId: string,
  orderId: string,
  driver: Point,
  db: DB,
): Promise<boolean> {
  const gateway = assignmentOrderGateway();
  const context = await gateway.context(deliveryId, db);
  if (!context?.pickup) return false;
  // A driver who became available but is outside the offer radius cannot help
  // this order; reopening would only burn another round of retries.
  if (haversineMeters(context.pickup, driver) > config.ASSIGNMENT_RADIUS_METERS) return false;
  return transaction(async (tx) => {
    const delivery = await deliveryForAssignmentLocked(deliveryId, tx);
    if (!delivery || delivery.status !== 'UNASSIGNED' || delivery.driver_id) return false;
    const order = await gateway.lockOrder(orderId, tx);
    if (!order || !ASSIGNABLE_ORDER_STATUSES.includes(order.status)) return false;
    const live = await tx.assignmentSearch.count({
      where: { delivery_id: deliveryId, status: { in: LIVE_SEARCH_STATUSES } },
    });
    if (live) return false;
    const latest = await tx.assignmentSearch.findFirst({
      where: { delivery_id: deliveryId },
      orderBy: { generation: 'desc' },
      select: { generation: true, status: true, offers_created: true },
    });
    if (!reopenable(latest)) return false;
    const inserted = await tx.$executeRaw`
      INSERT INTO assignment_searches (id, delivery_id, generation, deadline_at)
      VALUES (${id()}, ${deliveryId}, ${latest ? latest.generation + 1 : 1},
        clock_timestamp() + ${config.ASSIGNMENT_SEARCH_DEADLINE_SECONDS} * interval '1 second')
      ON CONFLICT DO NOTHING`;
    return inserted === 1;
  });
}

/**
 * A driver becoming available is new information for every delivery that is
 * still waiting for a courier. The first search for those deliveries may have
 * used up its rounds while nobody was online, which used to leave them
 * stranded until an administrator retried by hand. Reopen those searches so
 * the normal rotation can offer the work to the driver who just arrived.
 */
export async function redispatchForDriver(driverId: string, db: DB = prisma): Promise<number> {
  if (!config.ASSIGNMENT_AUTOMATION_ENABLED) return 0;
  if (!(await activeDriverIds([driverId], db)).length) return 0;
  const state = await availabilityInTransaction(driverId, db);
  if (!state.online || !state.ready || !state.heartbeatFresh || !state.locationFresh || state.busy)
    return 0;
  const location = await latestDriverLocation(driverId, db);
  if (!location) return 0;
  const driver: Point = { latitude: location.latitude, longitude: location.longitude };
  let reopened = 0;
  for (const delivery of await unassignedDeliveriesForBootstrap(undefined, 100, db)) {
    if (await reopenDelivery(delivery.id, delivery.order_id, driver, db)) reopened++;
  }
  return reopened;
}
