import type { Prisma } from '@prisma/client';
import { prisma, type DB } from '../../../shared/db.js';

/**
 * Read model for the public restaurant list and restaurant page.
 *
 * Projection exception (docs/DECISIONS.md): ratings and visible reviews are
 * read from the Review module's table for display only. Nothing here writes.
 */

export async function search(
  query: { q: string; cuisine: string },
  orderColumn: string,
  db: DB = prisma,
): Promise<any[]> {
  const where: Prisma.RestaurantWhereInput = { status: 'APPROVED', catalog_visible: true };
  if (query.cuisine) where.cuisine = query.cuisine;
  if (query.q)
    where.OR = [
      { name: { contains: query.q, mode: 'insensitive' } },
      { cuisine: { contains: query.q, mode: 'insensitive' } },
      {
        items: {
          some: { available: true, name: { contains: query.q, mode: 'insensitive' } },
        },
      },
    ];
  const orderBy: Prisma.RestaurantOrderByWithRelationInput =
    orderColumn === 'delivery_fee'
      ? { delivery_fee: 'asc' }
      : orderColumn === 'name'
        ? { name: 'asc' }
        : { created_at: 'asc' };
  const rows = await db.restaurant.findMany({
    where,
    orderBy,
    take: 100,
    include: { reviews: { where: { hidden: false }, select: { rating: true } } },
  });
  return rows.map(({ reviews, ...restaurant }) => {
    // Real reviews always win. Mock listings carry a simulated rating only
    // because their review count is part of the demo dataset.
    const realRating =
      reviews.length > 0
        ? Math.round(
            (reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) * 10,
          ) / 10
        : null;
    return {
      ...restaurant,
      rating: realRating ?? restaurant.rating ?? null,
      review_count: reviews.length || restaurant.review_count,
    };
  });
}

export async function listVisibleReviews(restaurantId: string, db: DB = prisma): Promise<any[]> {
  const rows = await db.review.findMany({
    where: { restaurant_id: restaurantId, hidden: false },
    orderBy: { created_at: 'desc' },
    take: 20,
    select: {
      rating: true,
      content: true,
      created_at: true,
      customer: { select: { name: true } },
    },
  });
  return rows.map(({ customer, ...review }) => ({ ...review, name: customer.name }));
}
