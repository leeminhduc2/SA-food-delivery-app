import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { ZodError } from 'zod';
import { catalogRoutes } from './api/catalog.routes.js';
import { deliveryRoutes } from './api/delivery.routes.js';
import { docsRoutes } from './api/docs.routes.js';
import { identityRoutes } from './api/identity.routes.js';
import { importRoutes } from './api/import.routes.js';
import { authenticate } from './api/middleware/authenticate.js';
import { operationsRoutes } from './api/operations.routes.js';
import { orderRoutes } from './api/orders.routes.js';
import { paymentActionRoutes, paymentRoutes } from './api/payments.routes.js';
import { AppError } from './domain/errors.js';
import { isPrismaError, prisma } from './db.js';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          'img-src': ["'self'", 'https:', 'data:'],
          'script-src': ["'self'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null,
        },
      },
    }),
  );
  app.use((req, res, next) => {
    req.requestId = randomUUID();
    res.setHeader('X-Request-Id', req.requestId);
    const start = performance.now();
    res.on('finish', () => {
      const elapsed = performance.now() - start;
      metrics.requests++;
      metrics.errors += Number(res.statusCode >= 500);
      metrics.durations.push(elapsed);
      if (metrics.durations.length > 10000) metrics.durations.shift();
      if (process.env.LOG_REQUESTS !== 'false')
        console.log(
          JSON.stringify({
            requestId: req.requestId,
            method: req.method,
            path: req.path,
            status: res.statusCode,
            durationMs: Math.round(elapsed),
          }),
        );
    });
    next();
  });
  app.get('/api/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ status: 'ok' });
  });
  app.use(
    '/api/payments',
    rateLimit({ windowMs: 60000, limit: 300 }),
    express.raw({ type: 'application/json', limit: '32kb' }),
    paymentRoutes,
  );
  app.use(express.json({ limit: '64kb' }));
  app.use('/api/docs', docsRoutes);
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const origin = req.headers.origin;
      const allowed = (
        process.env.APP_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173'
      ).split(',');
      if ((origin && !allowed.includes(origin)) || req.headers['x-requested-with'] !== 'Bep') {
        next(new AppError(403, 'CSRF', 'Untrusted request origin.'));
        return;
      }
    }
    next();
  });
  app.use('/api', authenticate);
  app.get('/api/config', (_req, res) =>
    res.json({
      simulatedPayments: simulatedPayments(),
      demoMode: process.env.DEMO_MODE === 'true',
    }),
  );
  app.get('/api/metrics', (req, res) => {
    if (req.user?.role !== 'ADMIN') {
      res.status(403).json({ message: 'Administrator access required.' });
      return;
    }
    const durations = [...metrics.durations].sort((a, b) => a - b);
    res.json({
      requests: metrics.requests,
      serverErrors: metrics.errors,
      p95Ms: durations[Math.floor(durations.length * 0.95)] || 0,
      p99Ms: durations[Math.floor(durations.length * 0.99)] || 0,
      window: 'last 10000 requests in this process',
    });
  });
  app.use(
    '/api/auth',
    rateLimit({ windowMs: 900000, limit: process.env.NODE_ENV === 'test' ? 1000 : 100 }),
    identityRoutes,
  );
  app.use('/api/checkout', rateLimit({ windowMs: 60000, limit: 60 }));
  app.use(
    '/api',
    catalogRoutes,
    orderRoutes,
    paymentActionRoutes,
    deliveryRoutes,
    operationsRoutes,
    importRoutes,
  );
  app.use('/api', (_req, _res, next) =>
    next(new AppError(404, 'NOT_FOUND', 'Endpoint not found.')),
  );
  app.use(express.static(resolve('dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(resolve('dist/index.html')));
  app.use(
    (error: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
      let status = error instanceof AppError ? error.status : 500;
      let code = error.code || 'INTERNAL_ERROR';
      let message =
        error instanceof AppError ? error.message : 'Something went wrong. Please try again.';
      if (error instanceof ZodError) {
        status = 400;
        code = 'VALIDATION';
        message = error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ');
      }
      if (error.code === '23505' || isPrismaError(error, 'P2002')) {
        status = 409;
        code = 'CONFLICT';
        message = 'This record already exists.';
      }
      if (error.type === 'entity.parse.failed') {
        status = 400;
        code = 'INVALID_JSON';
        message = 'Invalid JSON.';
      }
      if (status >= 500)
        console.error(JSON.stringify({ requestId: req.requestId, error: error.message }));
      res.status(status).json({ code, message, requestId: req.requestId });
    },
  );
  return app;
}

const simulatedPayments = () => process.env.PAYMENT_MODE === 'simulated';
const metrics = { requests: 0, errors: 0, durations: [] as number[] };
