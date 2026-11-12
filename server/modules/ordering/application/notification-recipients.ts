import type { DB } from '../../../shared/db.js';
import { restaurantMemberIds } from '../../catalog/index.js';
import { activeRestaurantIds } from '../../identity/index.js';

export async function restaurantRecipients(restaurantId: string, db: DB): Promise<string[]> {
  return activeRestaurantIds(await restaurantMemberIds(restaurantId, db), db);
}
