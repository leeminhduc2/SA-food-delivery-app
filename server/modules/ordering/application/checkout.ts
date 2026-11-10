import { createHash } from 'node:crypto';
import { id, transaction } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as audits from '../../../shared/audit.repository.js';
import { priceCart } from '../../catalog/index.js';
import { createDelivery } from '../../delivery/index.js';
import { checkoutDeliveryQuote, defaultAddressFor } from '../../location/index.js';
import { notify } from '../../notification/index.js';
import { createPayment, ensurePayment } from '../../payment/index.js';
import * as carts from '../infrastructure/cart.repository.js';
import * as orders from '../infrastructure/order.repository.js';
import { checkoutSchema } from '../ordering.schemas.js';
import { orderDetail } from './order-queries.js';

export async function checkout(actor: User, raw: unknown): Promise<any> {
  const input = checkoutSchema.parse(raw);
  const savedAddress = await defaultAddressFor(actor.id);
  const addressText = savedAddress?.address ?? input.address;
  check(addressText, 400, 'ADDRESS_REQUIRED', 'Add a delivery address before placing an order.');
  let routed: Awaited<ReturnType<typeof checkoutDeliveryQuote>> | null = null;
  if (savedAddress) {
    // Resolve the walking route before opening the stock-locking transaction.
    const preview = await transaction((db) => priceCart(db, input.items));
    routed = await checkoutDeliveryQuote(preview.restaurantId, savedAddress);
    if (!routed.info.supported) {
      if (routed.info.reason === 'OUT_OF_RANGE')
        check(
          false,
          409,
          'DELIVERY_UNSUPPORTED',
          `This restaurant is ${((routed.info.distanceMeters || 0) / 1000).toFixed(1)} km away on foot, beyond the 15 km delivery limit.`,
        );
      check(
        false,
        409,
        'DELIVERY_ROUTE_UNAVAILABLE',
        'We cannot calculate a walking delivery route to this address right now. Please try again or choose another address.',
      );
    }
  }
  const canonicalAddress = savedAddress?.address ?? addressText;
  const canonical = {
    address: canonicalAddress,
    note: input.note,
    expectedTotal: input.expectedTotal,
    items: input.items
      .map((line) => ({ ...line, optionIds: [...new Set(line.optionIds)].sort() }))
      .sort(
        (a, b) =>
          a.itemId.localeCompare(b.itemId) || a.optionIds.join().localeCompare(b.optionIds.join()),
      ),
  };
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
  const orderId = await transaction(async (db) => {
    // Serialize per customer/key before looking up a committed result. Unique constraint remains the final guard.
    await orders.advisoryCheckoutLock(actor.id + ':' + input.idempotencyKey, db);
    const old = await orders.findByCustomerAndKey(actor.id, input.idempotencyKey, db);
    if (old) {
      check(
        old.fingerprint === fingerprint,
        409,
        'IDEMPOTENCY_CONFLICT',
        'This checkout key was already used with different details.',
      );
      return old.id;
    }
    const quote = await priceCart(db, input.items, true);
    const deliveryFee = routed ? (routed.info.shippingFee as number) : quote.deliveryFee;
    const total = quote.subtotal + deliveryFee;
    check(
      total === input.expectedTotal,
      409,
      'PRICE_CHANGED',
      'Prices or the delivery fee changed. Review a fresh quote before ordering.',
    );
    const newOrderId = id();
    const expiry = new Date(Date.now() + Number(process.env.PAYMENT_WINDOW_MINUTES || 15) * 60000);
    await orders.insert(
      {
        id: newOrderId,
        customerId: actor.id,
        restaurantId: quote.restaurantId,
        subtotal: quote.subtotal,
        deliveryFee,
        total,
        address: addressText,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
        fingerprint,
        expiresAt: expiry,
        deliveryLatitude: routed?.info.supported ? savedAddress?.latitude : undefined,
        deliveryLongitude: routed?.info.supported ? savedAddress?.longitude : undefined,
        walkingDistanceMeters: routed?.info.supported
          ? (routed.info.distanceMeters as number)
          : undefined,
        walkingDurationSeconds: routed?.info.supported
          ? (routed.info.durationSeconds as number)
          : undefined,
      },
      db,
    );
    for (const item of quote.items)
      await orders.insertItem(
        {
          orderId: newOrderId,
          itemId: item.itemId,
          name: item.name,
          price: item.price,
          quantity: item.quantity,
          options: item.options,
        },
        id(),
        db,
      );
    await createPayment(db, newOrderId, total);
    await createDelivery(db, newOrderId);
    await audits.history(newOrderId, 'ORDER', null, 'PENDING_PAYMENT', actor.id, '', db);
    await notify(db, actor.id, 'ORDER_CREATED', { orderId: newOrderId });
    await carts.clear(actor.id, db);
    return newOrderId;
  });
  // Provider call is deliberately outside the business transaction; a worker retries the persisted reference.
  try {
    await ensurePayment(orderId);
  } catch {
    /* The pending payment remains recoverable. */
  }
  return orderDetail(orderId);
}
