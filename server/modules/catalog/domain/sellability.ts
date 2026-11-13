import { isOpenAt } from './opening-schedule.js';

export function sellability(
  item: { visible: boolean; available: boolean; stock: number },
  restaurant: {
    status: string;
    catalog_visible: boolean;
    accepting_orders: boolean;
    opening_schedule: unknown;
  },
  now: Date,
) {
  const unavailableReason =
    restaurant.status !== 'APPROVED' || !restaurant.catalog_visible || !restaurant.accepting_orders
      ? 'RESTAURANT_UNAVAILABLE'
      : !isOpenAt(restaurant.opening_schedule, now)
        ? 'RESTAURANT_CLOSED'
        : !item.visible
          ? 'ITEM_HIDDEN'
          : !item.available
            ? 'ITEM_UNAVAILABLE'
            : item.stock <= 0
              ? 'OUT_OF_STOCK'
              : null;
  return { sellable: unavailableReason === null, unavailableReason };
}
