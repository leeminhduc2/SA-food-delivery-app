import { prisma, type DB } from '../db.js';
import type { User } from '../domain/types.js';

export async function insert(tokenHash: string, userId: string, db: DB = prisma): Promise<void> {
  await db.session.create({
    data: {
      token_hash: tokenHash,
      user_id: userId,
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    },
  });
}

export async function findUserByToken(
  tokenHash: string,
  db: DB = prisma,
): Promise<User | undefined> {
  const session = await db.session.findFirst({
    where: {
      token_hash: tokenHash,
      expires_at: { gt: new Date() },
      user: { active: true },
    },
    select: {
      user: { select: { id: true, email: true, name: true, role: true, active: true } },
    },
  });
  return (session?.user as User | undefined) ?? undefined;
}

export async function deleteByToken(tokenHash: string, db: DB = prisma): Promise<void> {
  await db.session.deleteMany({ where: { token_hash: tokenHash } });
}

export async function deleteByUser(userId: string, db: DB = prisma): Promise<void> {
  await db.session.deleteMany({ where: { user_id: userId } });
}

export async function deleteExpired(db: DB = prisma): Promise<number> {
  return (await db.session.deleteMany({ where: { expires_at: { lt: new Date() } } })).count;
}
