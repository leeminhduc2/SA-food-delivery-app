import { z } from 'zod';

const positive = (max: number) =>
  z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().max(max));
const schema = z.object({
  DELIVERY_OTP_TTL_SECONDS: positive(600).default(600),
  DELIVERY_OTP_MAX_ATTEMPTS: positive(5).default(5),
});
export function parseDeliveryConfig(env: Record<string, string | undefined>) {
  return schema.parse(env);
}
export const deliveryConfig = parseDeliveryConfig(process.env);
