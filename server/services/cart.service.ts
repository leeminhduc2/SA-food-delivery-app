import { z } from 'zod';
import { transaction } from '../db.js';
import { check } from '../domain/errors.js';
import { linesSchema } from '../domain/schemas.js';
import type { User } from '../domain/types.js';
import * as cartRepository from '../repositories/cart.repository.js';
import { priceCart } from './catalog.service.js';

const cartSchema = z.object({
  items: linesSchema.or(z.array(z.never()).length(0)),
  version: z.number().int().min(0),
});

export async function get(actor: User): Promise<any> {
  return (
    (await cartRepository.findByCustomer(actor.id)) || {
      items: [],
      version: 0,
    }
  );
}

export async function put(actor: User, raw: unknown): Promise<any> {
  const input = cartSchema.parse(raw);
  return transaction(async (db) => {
    await cartRepository.ensure(actor.id, db);
    const cart = await cartRepository.findForUpdate(actor.id, db);
    check(cart, 404, 'NOT_FOUND', 'Basket not found.');
    check(
      cart.version === input.version,
      409,
      'CART_CONFLICT',
      'Basket changed in another tab. Refresh and try again.',
    );
    if (input.items.length) await priceCart(db, input.items);
    return cartRepository.updateItems(actor.id, input.items, db);
  });
}

/** Optional task: remove one dish from the persisted basket. */
export async function removeItem(actor: User, itemId: string): Promise<any> {
  return transaction(async (db) => {
    await cartRepository.ensure(actor.id, db);
    const cart = await cartRepository.findForUpdate(actor.id, db);
    check(cart, 404, 'NOT_FOUND', 'Basket not found.');
    const items = Array.isArray(cart.items) ? cart.items : [];
    const remaining = items.filter((line) => line.itemId !== itemId);
    check(
      remaining.length !== items.length,
      404,
      'CART_ITEM_NOT_FOUND',
      'This dish is not in your basket.',
    );
    return cartRepository.updateItems(actor.id, remaining, db);
  });
}
