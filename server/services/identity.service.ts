import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { check } from '../domain/errors.js';
import type { Role, User } from '../domain/types.js';
import * as sessions from '../repositories/session.repository.js';
import * as users from '../repositories/user.repository.js';

const scrypt = promisify(scryptCb);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + ((await scrypt(password, salt, 64)) as Buffer).toString('hex');
}

async function verify(password: string, hash: string): Promise<boolean> {
  const [salt, expected] = hash.split(':');
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}

const dummyHash = hashPassword('unusable-placeholder-password');

const registerSchema = z.object({
  name: z.string().trim().min(2).max(80),
  email: z
    .email()
    .max(200)
    .transform((s) => s.toLowerCase()),
  password: z.string().min(10).max(128),
  role: z.enum(['CUSTOMER', 'RESTAURANT', 'DRIVER']).default('CUSTOMER'),
});

const loginSchema = z.object({
  email: z.email().transform((s) => s.toLowerCase()),
  password: z.string().max(128),
});

const profileSchema = z.object({ name: z.string().trim().min(2).max(80) });

type UserRow = users.UserRow;

function publicUser(row: UserRow): User {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role as Role,
    active: row.active,
  };
}

async function issueSession(actor: UserRow): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await sessions.insert(digest(token), actor.id);
  return token;
}

export async function register(
  raw: unknown,
): Promise<{ pendingApproval: true } | { user: User; token: string }> {
  const input = registerSchema.parse(raw);
  const actor = await users.create({
    email: input.email,
    name: input.name,
    passwordHash: await hashPassword(input.password),
    role: input.role,
    active: input.role !== 'DRIVER',
  });
  if (!actor.active) return { pendingApproval: true };
  return { user: publicUser(actor), token: await issueSession(actor) };
}

export async function login(raw: unknown): Promise<{ user: User; token: string }> {
  const input = loginSchema.parse(raw);
  const actor = await users.findByEmail(input.email);
  // Perform equal-cost password work even for unknown accounts.
  const valid = await verify(input.password, actor?.password_hash ?? (await dummyHash));
  check(
    actor && valid && actor.active,
    401,
    'INVALID_LOGIN',
    'Email or password is incorrect, or your account is inactive.',
  );
  return { user: publicUser(actor), token: await issueSession(actor) };
}

export async function logout(token: string | undefined): Promise<void> {
  if (token) await sessions.deleteByToken(digest(token));
}

export async function updateName(actor: User, raw: unknown): Promise<User> {
  const { name } = profileSchema.parse(raw);
  return (await users.updateName(actor.id, name)) as User;
}

/** Used by the API authentication middleware; keeps SQL out of the HTTP layer. */
export async function resolveByToken(token: string | undefined): Promise<User | null> {
  if (!token) return null;
  return (await sessions.findUserByToken(digest(token))) ?? null;
}
