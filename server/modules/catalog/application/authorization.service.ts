import type { DB } from '../../../shared/db.js';
import { check } from '../../../shared/errors.js';
import type { User } from '../../../shared/types.js';
import * as restaurants from '../infrastructure/restaurant.repository.js';

export async function assertMember(
  db: DB | undefined,
  actor: User,
  restaurantId: string,
): Promise<void> {
  check(
    actor.role === 'RESTAURANT' && (await restaurants.isMember(actor.id, restaurantId, db)),
    403,
    'FORBIDDEN',
    'You do not manage this restaurant.',
  );
}
