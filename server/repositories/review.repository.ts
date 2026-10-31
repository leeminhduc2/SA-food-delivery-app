import { id, prisma, type DB } from '../db.js';

export async function insert(
  review: {
    orderId: string;
    customerId: string;
    restaurantId: string;
    rating: number;
    content: string;
  },
  db: DB = prisma,
): Promise<any> {
  return db.review.create({
    data: {
      id: id(),
      order_id: review.orderId,
      customer_id: review.customerId,
      restaurant_id: review.restaurantId,
      rating: review.rating,
      content: review.content,
    },
  });
}

export async function setHidden(
  reviewId: string,
  hidden: boolean,
  db: DB = prisma,
): Promise<{ id: string } | undefined> {
  const updated = await db.review.updateMany({ where: { id: reviewId }, data: { hidden } });
  return updated.count ? { id: reviewId } : undefined;
}

export async function listRecent(db: DB = prisma): Promise<any[]> {
  return db.review.findMany({ orderBy: { created_at: 'desc' }, take: 100 });
}
