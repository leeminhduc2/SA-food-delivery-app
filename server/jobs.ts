/** Background work run by the worker loop in index.ts (and directly by tests). */
import { registerModules } from './modules/index.js';
import { purgeExpiredSessions } from './modules/identity/index.js';
import { deliverNotifications } from './modules/notification/index.js';
import { expireUnpaidOrders } from './modules/ordering/index.js';
import { reconcilePayments } from './modules/payment/index.js';
import { purgeStaleDriverLocations } from './modules/location/index.js';
import { runAssignmentWorker } from './modules/assignment/index.js';

/** Settle payments with the provider, then release orders whose window closed. */
export async function runPaymentMaintenance(): Promise<void> {
  registerModules();
  await reconcilePayments();
  await expireUnpaidOrders();
}

/** One worker tick. */
export async function runBackgroundCycle(): Promise<void> {
  await runPaymentMaintenance();
  try {
    await runAssignmentWorker();
  } catch {
    // A failed assignment batch must not starve notification delivery.
    console.error('Assignment worker batch failed');
  }
  await deliverNotifications();
  await purgeExpiredSessions();
  await purgeStaleDriverLocations();
}
