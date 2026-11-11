/** Identity module public API. Other modules import only from this file. */
export { identityRoutes } from './identity.routes.js';
export { authenticate } from './authenticate.middleware.js';
export {
  findActiveDriver,
  hashPassword,
  listUsers,
  purgeExpiredSessions,
  resolveByToken,
  setAccountActive,
} from './identity.service.js';
