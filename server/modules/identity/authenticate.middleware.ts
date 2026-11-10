import type { RequestHandler } from 'express';
import { resolveByToken } from './identity.service.js';
import { tokenFrom } from '../../shared/http/actor.js';

/**
 * HTTP middleware only: read the cookie, ask the identity service who it is.
 * No SQL or session policy lives here.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  try {
    req.user = (await resolveByToken(tokenFrom(req.headers.cookie))) ?? undefined;
    next();
  } catch (error) {
    next(error);
  }
};
