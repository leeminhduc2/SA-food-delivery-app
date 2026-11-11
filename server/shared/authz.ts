import { check } from './errors.js';
import type { Role, User } from './types.js';

/**
 * Authorization policy that does not touch HTTP or the database. The API layer
 * turns the thrown AppError into a response; services only see an actor.
 */
export function requireActor(actor: User | undefined, ...allowed: Role[]): User {
  check(actor, 401, 'UNAUTHENTICATED', 'Please sign in.');
  check(
    !allowed.length || allowed.includes(actor.role),
    403,
    'FORBIDDEN',
    'This action is not available to your account.',
  );
  return actor;
}
