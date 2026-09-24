import { Router } from 'express';
import { z } from 'zod';
import { audit, check, imageSchema, linesSchema, member, user } from '../core.js';
import { id, one, pool, transaction, type DB } from '../db.js';
export const catalog = Router();
catalog.get('/restaurants', async (req, res) => {
  const query = z
    .object({
      q: z.string().max(100).default(''),
      cuisine: z.string().max(60).default(''),
      sort: z.enum(['recommended', 'fee', 'name']).default('recommended'),
    })
    .parse(req.query);
  const order = { recommended: 'r.created_at', fee: 'r.delivery_fee', name: 'r.name' }[query.sort];
  res.json(
    (
      await pool.query(
        `SELECT r.*, (SELECT round(avg(rating),1) FROM reviews v WHERE v.restaurant_id=r.id AND NOT v.hidden) AS rating, (SELECT count(*)::int FROM reviews v WHERE v.restaurant_id=r.id AND NOT v.hidden) AS review_count FROM restaurants r WHERE r.status='APPROVED' AND ($1='' OR r.name ILIKE $2 OR r.cuisine ILIKE $2 OR EXISTS(SELECT 1 FROM menu_items i WHERE i.restaurant_id=r.id AND i.available AND i.name ILIKE $2)) AND ($3='' OR r.cuisine=$3) ORDER BY ${order} LIMIT 100`,
        [query.q, `%${query.q}%`, query.cuisine],
      )
    ).rows,
  );
});
catalog.get('/restaurants/:id', async (req, res) => {
  const r = await one(pool, 'SELECT * FROM restaurants WHERE id=$1', [req.params.id]);
  check(r, 404, 'NOT_FOUND', 'Restaurant not found.');
  if (r.status !== 'APPROVED') await member(pool, user(req, 'RESTAURANT', 'ADMIN'), r.id);
  const items = (
    await pool.query(
      'SELECT i.*,m.name AS category FROM menu_items i JOIN menus m ON m.id=i.menu_id WHERE i.restaurant_id=$1 ORDER BY m.name,i.name',
      [r.id],
    )
  ).rows;
  const reviews = (
    await pool.query(
      'SELECT v.rating,v.content,v.created_at,u.name FROM reviews v JOIN users u ON u.id=v.customer_id WHERE v.restaurant_id=$1 AND NOT v.hidden ORDER BY v.created_at DESC LIMIT 20',
      [r.id],
    )
  ).rows;
  res.json({ ...r, items, reviews });
});
const restaurantSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500),
  address: z.string().trim().min(8).max(300),
  cuisine: z.string().min(2).max(60),
  image: imageSchema.default(''),
});
catalog.post('/restaurants', async (req, res) => {
  const actor = user(req, 'RESTAURANT');
  const r = restaurantSchema.parse(req.body);
  res.status(201).json(
    await transaction(async (db) => {
      const row = await one(
        db,
        'INSERT INTO restaurants(id,name,description,address,cuisine,image) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [id(), r.name, r.description, r.address, r.cuisine, r.image],
      );
      await db.query('INSERT INTO restaurant_members VALUES($1,$2)', [actor.id, row.id]);
      await audit(db, actor.id, 'RESTAURANT_REGISTERED', row.id);
      return row;
    }),
  );
});
catalog.patch('/restaurants/:id', async (req, res) => {
  const actor = user(req, 'RESTAURANT', 'ADMIN');
  const r = restaurantSchema.parse(req.body);
  res.json(
    await transaction(async (db) => {
      await member(db, actor, String(req.params.id));
      const row = await one(
        db,
        'UPDATE restaurants SET name=$1,description=$2,address=$3,cuisine=$4,image=$5 WHERE id=$6 RETURNING *',
        [r.name, r.description, r.address, r.cuisine, r.image, req.params.id],
      );
      await audit(db, actor.id, 'RESTAURANT_UPDATED', String(req.params.id));
      return row;
    }),
  );
});
catalog.get('/manage/restaurants', async (req, res) => {
  const actor = user(req, 'RESTAURANT', 'ADMIN');
  res.json(
    (
      await pool.query(
        "SELECT r.* FROM restaurants r WHERE $1='ADMIN' OR EXISTS(SELECT 1 FROM restaurant_members m WHERE m.restaurant_id=r.id AND m.user_id=$2) ORDER BY r.name",
        [actor.role, actor.id],
      )
    ).rows,
  );
});
const itemSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(500).default(''),
  price: z.number().int().min(1000).max(10000000),
  stock: z.number().int().min(0).max(100000),
  available: z.boolean(),
  image: imageSchema.default(''),
  category: z.string().min(1).max(60).default('Main dishes'),
  options: z
    .array(
      z.object({
        id: z.string().min(1).max(60),
        name: z.string().min(1).max(80),
        extraPrice: z.number().int().min(0).max(1000000),
      }),
    )
    .max(10)
    .refine(
      (a) => new Set(a.map((o) => o.id)).size === a.length,
      'Option identifiers must be unique.',
    )
    .default([]),
});
catalog.post('/restaurants/:id/items', async (req, res) => {
  const actor = user(req, 'RESTAURANT', 'ADMIN');
  const i = itemSchema.parse(req.body);
  res.status(201).json(
    await transaction(async (db) => {
      await member(db, actor, String(req.params.id));
      const menu = await one(
        db,
        'INSERT INTO menus(id,restaurant_id,name) VALUES($1,$2,$3) ON CONFLICT(restaurant_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id',
        [id(), req.params.id, i.category],
      );
      const row = await one(
        db,
        'INSERT INTO menu_items(id,restaurant_id,menu_id,name,description,price,stock,available,image,options) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [
          id(),
          req.params.id,
          menu.id,
          i.name,
          i.description,
          i.price,
          i.stock,
          i.available,
          i.image,
          JSON.stringify(i.options),
        ],
      );
      await audit(db, actor.id, 'ITEM_CREATED', row.id);
      return row;
    }),
  );
});
catalog.put('/items/:id', async (req, res) => {
  const actor = user(req, 'RESTAURANT', 'ADMIN');
  const i = itemSchema.parse(req.body);
  res.json(
    await transaction(async (db) => {
      const old = await one(db, 'SELECT * FROM menu_items WHERE id=$1 FOR UPDATE', [req.params.id]);
      check(old, 404, 'NOT_FOUND', 'Item not found.');
      await member(db, actor, old.restaurant_id);
      const menu = await one(
        db,
        'INSERT INTO menus(id,restaurant_id,name) VALUES($1,$2,$3) ON CONFLICT(restaurant_id,name) DO UPDATE SET name=EXCLUDED.name RETURNING id',
        [id(), old.restaurant_id, i.category],
      );
      const row = await one(
        db,
        'UPDATE menu_items SET name=$1,description=$2,price=$3,stock=$4,available=$5,image=$6,options=$7,menu_id=$8 WHERE id=$9 RETURNING *',
        [
          i.name,
          i.description,
          i.price,
          i.stock,
          i.available,
          i.image,
          JSON.stringify(i.options),
          menu.id,
          old.id,
        ],
      );
      await audit(db, actor.id, 'ITEM_UPDATED', old.id, { oldPrice: old.price, newPrice: i.price });
      return row;
    }),
  );
});
catalog.delete('/items/:id', async (req, res) => {
  const actor = user(req, 'RESTAURANT', 'ADMIN');
  await transaction(async (db) => {
    const item = await one(db, 'SELECT * FROM menu_items WHERE id=$1 FOR UPDATE', [req.params.id]);
    check(item, 404, 'NOT_FOUND', 'Item not found.');
    await member(db, actor, item.restaurant_id);
    await db.query('UPDATE menu_items SET available=false WHERE id=$1', [item.id]);
    await audit(db, actor.id, 'ITEM_ARCHIVED', item.id);
  });
  res.json({ ok: true });
});
export async function priceCart(db: DB, raw: unknown, reserve = false) {
  const lines = linesSchema
    .parse(raw)
    .map((l) => ({ ...l, optionIds: [...new Set(l.optionIds)].sort() }))
    .sort(
      (a, b) =>
        a.itemId.localeCompare(b.itemId) || a.optionIds.join().localeCompare(b.optionIds.join()),
    );
  const items = [];
  let restaurant: any;
  let subtotal = 0;
  // Lock restaurant before items; all item locks have a consistent order.
  const first = await one(db, 'SELECT restaurant_id FROM menu_items WHERE id=$1', [
    lines[0].itemId,
  ]);
  check(first, 404, 'NOT_FOUND', 'Item not found.');
  restaurant = await one(
    db,
    `SELECT * FROM restaurants WHERE id=$1 ${reserve ? 'FOR SHARE' : ''}`,
    [first.restaurant_id],
  );
  check(
    restaurant?.status === 'APPROVED',
    409,
    'UNAVAILABLE',
    'This restaurant is not accepting orders.',
  );
  const quantities = new Map<string, number>();
  for (const l of lines) quantities.set(l.itemId, (quantities.get(l.itemId) || 0) + l.quantity);
  for (const [itemId, quantity] of quantities) {
    const item = await one(
      db,
      `SELECT * FROM menu_items WHERE id=$1 ${reserve ? 'FOR UPDATE' : ''}`,
      [itemId],
    );
    check(
      item && item.restaurant_id === restaurant.id,
      409,
      'SINGLE_RESTAURANT',
      'Your basket must contain items from one restaurant.',
    );
    check(item.available, 409, 'UNAVAILABLE', `${item.name} is no longer available.`);
    check(
      item.stock >= quantity,
      409,
      'OUT_OF_STOCK',
      `${item.name} has only ${item.stock} servings left.`,
    );
    if (reserve)
      await db.query('UPDATE menu_items SET stock=stock-$1 WHERE id=$2', [quantity, item.id]);
    for (const line of lines.filter((l) => l.itemId === itemId)) {
      const options = line.optionIds.map((optionId) => {
        const option = item.options.find((o: any) => o.id === optionId);
        check(option, 409, 'INVALID_OPTION', 'An option is no longer available.');
        return option;
      });
      const price = item.price + options.reduce((s: number, o: any) => s + o.extraPrice, 0);
      subtotal += price * line.quantity;
      items.push({
        itemId: item.id,
        name: item.name,
        quantity: line.quantity,
        price,
        options,
        image: item.image,
      });
    }
  }
  check(
    subtotal + restaurant.delivery_fee <= 2_000_000_000,
    400,
    'TOTAL_TOO_LARGE',
    'Order total exceeds the supported limit.',
  );
  return {
    restaurantId: restaurant.id,
    restaurantName: restaurant.name,
    items,
    subtotal,
    deliveryFee: restaurant.delivery_fee,
    total: subtotal + restaurant.delivery_fee,
    currency: 'VND',
  };
}
export async function releaseStock(db: DB, items: { menu_item_id: string; quantity: number }[]) {
  for (const i of items)
    await db.query('UPDATE menu_items SET stock=stock+$1 WHERE id=$2', [
      i.quantity,
      i.menu_item_id,
    ]);
}
