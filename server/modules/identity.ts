import type { RequestHandler, Response } from 'express';
import { Router } from 'express';
import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { check, user, type User } from '../core.js';
import { id, one, pool } from '../db.js';
const scrypt = promisify(scryptCb);
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + ((await scrypt(password, salt, 64)) as Buffer).toString('hex');
}
async function verify(password: string, hash: string) {
  const [salt, expected] = hash.split(':');
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const tokenFrom = (cookie = '') =>
  cookie
    .split(';')
    .map((c) => c.trim())
    .find((c) => c.startsWith('session='))
    ?.slice(8);
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    const token = tokenFrom(req.headers.cookie);
    if (token)
      req.user = await one(
        pool,
        'SELECT u.id,u.email,u.name,u.role,u.active FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active=true',
        [digest(token)],
      );
    next();
  } catch (e) {
    next(e);
  }
};
async function session(res: Response, actor: User) {
  const token = randomBytes(32).toString('hex');
  await pool.query(
    "INSERT INTO sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '7 days')",
    [digest(token), actor.id],
  );
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 604800000,
    path: '/',
  });
  return {
    id: actor.id,
    name: actor.name,
    email: actor.email,
    role: actor.role,
    active: actor.active,
  };
}
export const identity = Router();
identity.post('/register', async (req, res) => {
  const input = z
    .object({
      name: z.string().trim().min(2).max(80),
      email: z
        .email()
        .max(200)
        .transform((s) => s.toLowerCase()),
      password: z.string().min(10).max(128),
      role: z.enum(['CUSTOMER', 'RESTAURANT', 'DRIVER']).default('CUSTOMER'),
    })
    .parse(req.body);
  const actor = await one(
    pool,
    'INSERT INTO users(id,email,name,password_hash,role,active) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
    [
      id(),
      input.email,
      input.name,
      await hashPassword(input.password),
      input.role,
      input.role !== 'DRIVER',
    ],
  );
  if (!actor.active) {
    res.status(201).json({ pendingApproval: true });
    return;
  }
  res.status(201).json(await session(res, actor));
});
identity.post('/login', async (req, res) => {
  const input = z
    .object({ email: z.email().transform((s) => s.toLowerCase()), password: z.string().max(128) })
    .parse(req.body);
  const actor = await one(pool, 'SELECT * FROM users WHERE email=$1', [input.email]);
  // Perform equal-cost password work even for unknown accounts.
  const valid = await verify(input.password, actor?.password_hash ?? (await dummyHash));
  check(
    actor && valid && actor.active,
    401,
    'INVALID_LOGIN',
    'Email or password is incorrect, or your account is inactive.',
  );
  res.json(await session(res, actor));
});
const dummyHash = hashPassword('unusable-placeholder-password');
identity.post('/logout', async (req, res) => {
  const token = tokenFrom(req.headers.cookie);
  if (token) await pool.query('DELETE FROM sessions WHERE token_hash=$1', [digest(token)]);
  res.clearCookie('session', { path: '/' }).json({ ok: true });
});
identity.get('/me', (req, res) => res.json(req.user || null));
identity.patch('/me', async (req, res) => {
  const actor = user(req);
  const { name } = z.object({ name: z.string().trim().min(2).max(80) }).parse(req.body);
  res.json(
    await one(pool, 'UPDATE users SET name=$1 WHERE id=$2 RETURNING id,email,name,role,active', [
      name,
      actor.id,
    ]),
  );
});
