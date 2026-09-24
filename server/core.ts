import type { Request } from 'express';
import { z } from 'zod';
import { id, one, type DB } from './db.js';
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export function check(ok: unknown, status: number, code: string, message: string): asserts ok {
  if (!ok) throw new AppError(status, code, message);
}
export type User = {
  id: string;
  email: string;
  name: string;
  role: 'CUSTOMER' | 'RESTAURANT' | 'DRIVER' | 'ADMIN';
  active: boolean;
};
declare global {
  namespace Express {
    interface Request {
      user?: User;
      requestId: string;
    }
  }
}
export function user(req: Request, ...roles: User['role'][]) {
  check(req.user, 401, 'UNAUTHENTICATED', 'Please sign in.');
  check(
    !roles.length || roles.includes(req.user.role),
    403,
    'FORBIDDEN',
    'This action is not available to your account.',
  );
  return req.user;
}
export async function member(db: DB, actor: User, restaurantId: string) {
  check(
    actor.role === 'ADMIN' ||
      (await one(db, 'SELECT 1 FROM restaurant_members WHERE user_id=$1 AND restaurant_id=$2', [
        actor.id,
        restaurantId,
      ])),
    403,
    'FORBIDDEN',
    'You do not manage this restaurant.',
  );
}
export async function audit(db: DB, actor: string, action: string, resource: string, detail = {}) {
  await db.query(
    'INSERT INTO audit_logs(id,actor,action,resource_id,detail) VALUES($1,$2,$3,$4,$5)',
    [id(), actor, action, resource, JSON.stringify(detail)],
  );
}
export async function history(
  db: DB,
  orderId: string,
  entity: string,
  from: string | null,
  to: string,
  actor: string,
  reason = '',
) {
  await db.query(
    'INSERT INTO state_history(id,order_id,entity,from_state,to_state,actor,reason) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [id(), orderId, entity, from, to, actor, reason],
  );
}
export async function notify(db: DB, userId: string, type: string, payload: unknown) {
  await db.query('INSERT INTO outbox(id,user_id,type,payload) VALUES($1,$2,$3,$4)', [
    id(),
    userId,
    type,
    JSON.stringify(payload),
  ]);
}
export const lineSchema = z.object({
  itemId: z.string().min(1),
  quantity: z.number().int().min(1).max(20),
  optionIds: z.array(z.string()).max(10).default([]),
});
export const linesSchema = z.array(lineSchema).min(1).max(40);
export const imageSchema = z
  .string()
  .max(1000)
  .refine(
    (s) => !s || /^https:\/\//.test(s) || /^\/images\/[a-z0-9.-]+$/.test(s),
    'Use an HTTPS image URL.',
  );
