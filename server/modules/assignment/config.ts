import { z } from 'zod';
const positive = z.coerce.number().int().positive();
const configSchema = z.object({
  ASSIGNMENT_AUTOMATION_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  ASSIGNMENT_STRATEGY: z.literal('NEAREST').default('NEAREST'),
  ASSIGNMENT_OFFER_TTL_SECONDS: positive.default(30),
  ASSIGNMENT_RADIUS_METERS: positive.default(5000),
  ASSIGNMENT_MAX_OFFERS: positive.default(10),
  ASSIGNMENT_MAX_ROUNDS: positive.default(3),
  ASSIGNMENT_SEARCH_DEADLINE_SECONDS: positive.default(600),
  DRIVER_LOCATION_MAX_AGE_SECONDS: positive.default(90),
  DRIVER_LOCATION_MAX_FUTURE_SECONDS: positive.default(15),
  DRIVER_LOCATION_MIN_INTERVAL_SECONDS: positive.default(5),
  DRIVER_HEARTBEAT_INTERVAL_SECONDS: positive.default(30),
  DRIVER_HEARTBEAT_MAX_AGE_SECONDS: positive.default(90),
  OFFLINE_LOCATION_RETENTION_SECONDS: positive.default(900),
  TRACKING_LOCATION_TTL_SECONDS: positive.default(120),
  TRACKING_POLL_SECONDS: positive.default(15),
});
export type AssignmentConfig = z.infer<typeof configSchema>;
export function parseAssignmentConfig(env: Record<string, string | undefined>): AssignmentConfig {
  return configSchema.parse(env);
}
export const assignmentConfig = parseAssignmentConfig(process.env);
