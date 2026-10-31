import { id, prisma, type DB } from '../db.js';
import type { Role, User } from '../domain/types.js';

export type UserRow = User & { password_hash: string };

export async function findByEmail(email: string, db: DB = prisma): Promise<UserRow | undefined> {
  return ((await db.user.findUnique({ where: { email } })) as UserRow | null) ?? undefined;
}

export async function findById(userId: string, db: DB = prisma): Promise<UserRow | undefined> {
  return ((await db.user.findUnique({ where: { id: userId } })) as UserRow | null) ?? undefined;
}

export async function create(
  input: { email: string; name: string; passwordHash: string; role: Role; active: boolean },
  db: DB = prisma,
): Promise<UserRow> {
  return db.user.create({
    data: {
      id: id(),
      email: input.email,
      name: input.name,
      password_hash: input.passwordHash,
      role: input.role,
      active: input.active,
    },
  }) as Promise<UserRow>;
}

export async function updateName(
  userId: string,
  name: string,
  db: DB = prisma,
): Promise<User | undefined> {
  const updated = await db.user.updateMany({
    where: { id: userId },
    data: { name },
  });
  if (!updated.count) return undefined;
  return (
    ((await db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, role: true, active: true },
    })) as User | null) ?? undefined
  );
}

export async function setActive(
  userId: string,
  active: boolean,
  db: DB = prisma,
): Promise<{ id: string } | undefined> {
  const updated = await db.user.updateMany({ where: { id: userId }, data: { active } });
  return updated.count ? { id: userId } : undefined;
}

export async function findActiveDriver(
  userId: string,
  db: DB = prisma,
): Promise<{ id: string } | undefined> {
  return (
    (await db.user.findFirst({
      where: { id: userId, role: 'DRIVER', active: true },
      select: { id: true },
    })) ?? undefined
  );
}

export async function listAll(db: DB = prisma): Promise<User[]> {
  return (await db.user.findMany({
    select: { id: true, name: true, email: true, role: true, active: true },
    orderBy: { name: 'asc' },
  })) as User[];
}
