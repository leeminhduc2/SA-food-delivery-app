import { z } from 'zod';

const positive = (max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().max(max));
const flag = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true')
  .default(true);
const schema = z.object({
  DELIVERY_OTP_TTL_SECONDS: positive(600).default(600),
  DELIVERY_OTP_MAX_ATTEMPTS: positive(5).default(5),
  DELIVERY_PROOF_REQUIRED: flag,
  DELIVERY_PROOF_MAX_BYTES: positive(5242880).default(5242880),
  DELIVERY_PROOF_RETENTION_DAYS: positive(3650).default(30),
  DELIVERY_PROOF_STORAGE_DIR: z.string().trim().min(1).default('.data/delivery-proofs'),
});
export type DeliveryConfig = z.infer<typeof schema>;
export function parseDeliveryConfig(env: Record<string, string | undefined>): DeliveryConfig {
  return schema.parse(env);
}
export const deliveryConfig = parseDeliveryConfig(process.env);
