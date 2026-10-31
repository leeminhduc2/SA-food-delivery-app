import { z } from 'zod';
import { transaction } from '../db.js';
import { check } from '../domain/errors.js';
import type { User } from '../domain/types.js';
import * as audits from '../repositories/audit.repository.js';
import * as reviews from '../repositories/review.repository.js';
import { accessOrder } from './order.service.js';

const reviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  content: z.string().trim().min(3).max(1000),
});

export async function create(actor: User, orderId: string, raw: unknown): Promise<any> {
  const input = reviewSchema.parse(raw);
  return transaction(async (db) => {
    const order = await accessOrder(db, actor, orderId, true);
    check(
      order.status === 'DELIVERED',
      409,
      'NOT_DELIVERED',
      'Only delivered orders can be reviewed.',
    );
    return reviews.insert(
      {
        orderId: order.id,
        customerId: actor.id,
        restaurantId: order.restaurant_id,
        rating: input.rating,
        content: input.content,
      },
      db,
    );
  });
}

export async function moderate(actor: User, reviewId: string, raw: unknown): Promise<void> {
  const { hidden } = z.object({ hidden: z.boolean() }).parse(raw);
  await transaction(async (db) => {
    const row = await reviews.setHidden(reviewId, hidden, db);
    check(row, 404, 'NOT_FOUND', 'Review not found.');
    await audits.audit(actor.id, 'REVIEW_MODERATED', row.id, { hidden }, db);
  });
}
