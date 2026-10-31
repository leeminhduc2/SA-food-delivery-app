import type { Request } from 'express';
import { requireActor } from '../../domain/authz.js';
import type { Role, User } from '../../domain/types.js';

declare global {
  namespace Express {
    interface Request {
      user?: User;
      requestId: string;
    }
  }
}

/** HTTP-side adapter over the pure authorization policy. */
export function actor(req: Request, ...roles: Role[]): User {
  return requireActor(req.user, ...roles);
}

/** Extract the opaque session token from the Cookie header. */
export function tokenFrom(cookie = ''): string | undefined {
  return cookie
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith('session='))
    ?.slice(8);
}
