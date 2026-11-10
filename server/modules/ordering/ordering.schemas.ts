import { z } from 'zod';
import { linesSchema } from '../catalog/index.js';

/** Request bodies accepted by the ordering routes. */
export const checkoutSchema = z.object({
  items: linesSchema,
  address: z.string().trim().min(8).max(300).optional(),
  note: z.string().trim().max(500).default(''),
  expectedTotal: z.number().int().positive(),
  idempotencyKey: z.string().min(8).max(120),
});

export const transitionSchema = z.object({
  status: z.enum(['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP']),
});

export const cancelSchema = z.object({ reason: z.string().trim().min(3).max(300) });
