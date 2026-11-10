import { forgetAddressQuotes, type SavedDeliveryAddress } from '../../location/index.js';
import * as restaurants from '../infrastructure/restaurant.repository.js';
import { deliveryInfoForRestaurant } from './restaurant-location.js';

/**
 * Saving an address replaces its cached quotes with one snapshot per visible
 * restaurant. The caller awaits this, so a subsequent catalog/checkout read
 * can rely on the fresh prices without calling the router again.
 */
export async function prefetchDeliveryQuotes(address: SavedDeliveryAddress): Promise<void> {
  await forgetAddressQuotes(address.id);
  const rows = await restaurants.listQuotable();
  await Promise.all(
    rows.map(async (restaurant) => {
      try {
        await deliveryInfoForRestaurant(restaurant, address, { includeGeometry: true });
      } catch (error) {
        // One broken restaurant (or a provider outage) must not block the
        // address save. The missed snapshot is recomputed on demand.
        console.error(`Delivery quote prefetch failed for ${restaurant.id}`, error);
      }
    }),
  );
}
