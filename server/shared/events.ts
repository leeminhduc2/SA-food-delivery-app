import type { DB } from './db.js';

/**
 * In-process domain events. A module announces what happened to *its own*
 * data; other modules react without the publisher importing them.
 *
 * Handlers run synchronously, in subscription order, inside the publisher's
 * transaction (`db`). A handler that throws rolls the whole transaction back,
 * so cross-module side effects stay atomic exactly as direct calls were.
 */
export type DomainEvents = {
  /** The provider confirmed a payment while the order still accepted it. */
  PaymentSucceeded: { orderId: string; actor: string };
  /** Payment failed, expired or arrived after the payment window closed. */
  PaymentFailed: { orderId: string; actor: string; reason?: string };
  OrderAccepted: { orderId: string; deliveryId: string; actor: string };
  DeliveryPickedUp: { orderId: string; actor: string };
  DeliveryCompleted: { orderId: string; actor: string };
  DeliveryFailed: { orderId: string; actor: string; reason: string };
};

export type EventName = keyof DomainEvents;
export type EventHandler<K extends EventName> = (db: DB, event: DomainEvents[K]) => Promise<void>;

const handlers: { [K in EventName]?: EventHandler<K>[] } = {};

export function subscribe<K extends EventName>(name: K, handler: EventHandler<K>): void {
  const list = (handlers[name] ??= []) as EventHandler<K>[];
  list.push(handler);
}

export async function publish<K extends EventName>(
  db: DB,
  name: K,
  event: DomainEvents[K],
): Promise<void> {
  for (const handler of (handlers[name] ?? []) as EventHandler<K>[]) await handler(db, event);
}
