import { z } from 'zod';

const schema = z.object({
  REFUND_MAX_ATTEMPTS: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(10))
    .default(5),
});
export function parsePaymentConfig(env: Record<string, string | undefined>) {
  return schema.parse(env);
}
export const paymentConfig = parsePaymentConfig(process.env);
/** Delay before attempt n+1, in seconds: 30, 60, 120, 240, then 480 if configured higher. */
export const refundBackoffSeconds = (attempt: number) => 30 * 2 ** Math.max(0, attempt - 1);
