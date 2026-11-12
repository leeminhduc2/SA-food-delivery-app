/**
 * Composition root. The only place that knows how modules plug into each
 * other at runtime: it hands Ordering's gateways to the ports Payment and
 * Delivery declare, and subscribes Ordering to their events.
 * Safe to call more than once.
 */
import { setDeliveryOrderGateway } from './delivery/index.js';
import { prefetchDeliveryQuotes } from './catalog/index.js';
import { setAddressSavedListener, configureDriverLocation } from './location/index.js';
import { assignmentConfig, retainDriverLocation } from './assignment/index.js';
import {
  deliveryOrderGateway,
  paymentOrderGateway,
  registerOrderingHandlers,
} from './ordering/index.js';
import { setPaymentOrderGateway } from './payment/index.js';

let registered = false;

export function registerModules(): void {
  if (registered) return;
  registered = true;
  setPaymentOrderGateway(paymentOrderGateway);
  setDeliveryOrderGateway(deliveryOrderGateway);
  registerOrderingHandlers();
  // Saving a delivery address prefetches one persisted quote per visible
  // restaurant; the catalog owns restaurant knowledge, location owns the event.
  setAddressSavedListener(prefetchDeliveryQuotes);
  configureDriverLocation(
    {
      maxAgeSeconds: assignmentConfig.DRIVER_LOCATION_MAX_AGE_SECONDS,
      maxFutureSeconds: assignmentConfig.DRIVER_LOCATION_MAX_FUTURE_SECONDS,
      minIntervalSeconds: assignmentConfig.DRIVER_LOCATION_MIN_INTERVAL_SECONDS,
      retentionSeconds: assignmentConfig.OFFLINE_LOCATION_RETENTION_SECONDS,
    },
    retainDriverLocation,
  );
}
