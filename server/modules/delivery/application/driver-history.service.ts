import { z } from 'zod';
import { check } from '../../../shared/errors.js';
import { driverHistory } from '../infrastructure/driver-history.projection.js';

export async function history(driverId: string, raw: unknown) {
  const input = z
    .object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      cursor: z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z0-9_-]+$/)
        .optional(),
    })
    .parse(raw);
  let cursorId: string | undefined;
  if (input.cursor) {
    cursorId = Buffer.from(input.cursor, 'base64url').toString('utf8');
    check(
      Boolean(cursorId) && Buffer.from(cursorId).toString('base64url') === input.cursor,
      400,
      'INVALID_CURSOR',
      'Invalid history cursor.',
    );
  }
  const result = await driverHistory(driverId, input.limit, cursorId);
  check(result, 400, 'INVALID_CURSOR', 'Invalid history cursor.');
  return result;
}
