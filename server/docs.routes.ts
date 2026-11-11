import { Router } from 'express';
import { resolve } from 'node:path';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

export const docsRoutes = Router();

// Swagger UI renders its initializer inline. Relax CSP only for this route.
docsRoutes.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        'default-src': ["'self'"],
        'script-src': ["'self'", "'unsafe-inline'"],
        'style-src': ["'self'", "'unsafe-inline'"],
        'img-src': ["'self'", 'data:'],
        'font-src': ["'self'", 'data:'],
        'connect-src': ["'self'"],
        'upgrade-insecure-requests': process.env.NODE_ENV === 'production' ? [] : null,
      },
    },
  }),
);

docsRoutes.get('/openapi.yaml', (_req, res) => {
  res.sendFile(resolve('openapi.yaml'));
});

docsRoutes.use(
  '/',
  swaggerUi.serve,
  swaggerUi.setup(
    {},
    {
      swaggerOptions: {
        url: '/api/docs/openapi.yaml',
        withCredentials: true,
        requestInterceptor: (request: any) => {
          request.headers['x-requested-with'] = 'Bep';
          return request;
        },
      },
    },
  ),
);
