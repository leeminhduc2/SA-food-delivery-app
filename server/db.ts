import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

/**
 * One client per process. Reusing the client across dev reloads avoids
 * exhausting PostgreSQL connections.
 */
export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });
if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;

/** A Prisma client or the transaction-scoped client passed to `transaction`. */
export type DB = Prisma.TransactionClient;

export const id = () => randomUUID();

/**
 * Interactive transaction. The callback must use only the supplied `db`
 * client so every statement participates in the same transaction.
 */
export async function transaction<T>(
  fn: (db: DB) => Promise<T>,
  options: { timeout?: number; maxWait?: number } = {},
): Promise<T> {
  return prisma.$transaction(fn, {
    maxWait: options.maxWait ?? 10000,
    timeout: options.timeout ?? 20000,
  });
}

export function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

export function uniqueViolation(error: unknown): boolean {
  return isPrismaError(error, 'P2002') || (error as { code?: string })?.code === '23505';
}

/**
 * Database clock. Use this for due-window predicates where comparing a column
 * written with `now()` against the application clock would let client/database
 * clock skew change the result.
 */
export async function dbNow(db: DB = prisma): Promise<Date> {
  const rows = await db.$queryRaw<{ now: Date }[]>`SELECT now() AS now`;
  return rows[0].now;
}

/** Lock one row for the rest of the current transaction. */
export async function lockRow(
  db: DB,
  table: 'restaurants' | 'menu_items' | 'carts' | 'orders' | 'payments' | 'deliveries',
  column: 'id' | 'order_id' | 'reference' | 'customer_id',
  value: string,
  mode: 'UPDATE' | 'SHARE' = 'UPDATE',
): Promise<void> {
  // Prisma has no row-lock API. Identifiers come from this closed union and the
  // value is parameterised, so no user input is interpolated into SQL.
  await db.$queryRawUnsafe(
    `SELECT ${column} FROM ${table} WHERE ${column} = $1 FOR ${mode}`,
    value,
  );
}
