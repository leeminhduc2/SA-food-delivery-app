/**
 * Composition root. The only place that knows how modules plug into each
 * other at runtime: it hands Ordering's gateways to the ports Payment and
 * Delivery declare, and subscribes Ordering to their events.
 * Safe to call more than once.
 */
import { setDeliveryOrderGateway } from './delivery/index.js';
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
}
