/** Background work run by the worker loop in index.ts (and directly by tests). */
import { registerModules } from './modules/index.js';
import { recordStage } from './shared/job-status.js';
import { alertBacklog } from './modules/backoffice/index.js';
import { purgeExpiredSessions } from './modules/identity/index.js';
import { deliverNotifications } from './modules/notification/index.js';
import { expireUnpaidOrders } from './modules/ordering/index.js';
import { reconcilePayments } from './modules/payment/index.js';
import { purgeStaleDriverLocations } from './modules/location/index.js';
import { runAssignmentWorker, runOperationalInvalidation } from './modules/assignment/index.js';
import { cleanupStagedUploads, purgeExpiredProofPhotos } from './modules/delivery/index.js';

/** Settle payments with the provider, then release orders whose window closed. */
export async function runPaymentMaintenance(): Promise<void> {
  registerModules();
  await reconcilePayments();
  await expireUnpaidOrders();
}

/** One worker tick. */
export async function runBackgroundCycle(): Promise<void> {
  registerModules();
  await runIsolatedStages([
    { name: 'payment reconciliation', run: reconcilePayments },
    { name: 'payment expiry', run: expireUnpaidOrders },
    { name: 'assignment', run: runAssignmentWorker },
    { name: 'driver operational invalidation', run: runOperationalInvalidation },
    { name: 'notification', run: deliverNotifications },
    { name: 'session cleanup', run: purgeExpiredSessions },
    { name: 'location cleanup', run: purgeStaleDriverLocations },
    { name: 'proof upload cleanup', run: () => cleanupStagedUploads() },
    { name: 'proof retention', run: () => purgeExpiredProofPhotos() },
    { name: 'backlog alerts', run: () => alertBacklog() },
  ]);
}

export async function runIsolatedStages(
  stages: readonly { name: string; run: () => Promise<unknown> }[],
): Promise<string[]> {
  const failed: string[] = [];
  for (const stage of stages) {
    try {
      await stage.run();
      recordStage(stage.name);
    } catch (error) {
      failed.push(stage.name);
      recordStage(stage.name, error);
      console.error(`Background stage failed: ${stage.name}`);
    }
  }
  return failed;
}
