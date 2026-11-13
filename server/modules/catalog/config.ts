import { z } from 'zod';

const inventorySchema = z.object({
  LOW_STOCK_THRESHOLD: z
    .string()
    .regex(/^\d+$/)
    .default('5')
    .transform(Number)
    .pipe(z.number().int().min(0).max(100000)),
});
export function parseInventoryConfig(env: Record<string, string | undefined>) {
  return inventorySchema.parse(env);
}
export const inventoryConfig = parseInventoryConfig(process.env);
