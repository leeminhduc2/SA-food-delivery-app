/**
 * Reconcile the OpenAPI document with the routes actually registered by the
 * Express routers. Run with `npm run check:openapi`.
 *
 * Parsing registration source (rather than Express' internal router stack) is
 * deliberate: Express 5 exposes no stable public API for walking mounted
 * routers, and the call shape `router.method('path', …)` is stable here.
 */
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const routeFiles: Array<{ file: string; router: string; prefix: string }> = [
  { file: 'server/api/identity.routes.ts', router: 'identityRoutes', prefix: '/api/auth' },
  { file: 'server/api/catalog.routes.ts', router: 'catalogRoutes', prefix: '/api' },
  { file: 'server/api/orders.routes.ts', router: 'orderRoutes', prefix: '/api' },
  { file: 'server/api/payments.routes.ts', router: 'paymentRoutes', prefix: '/api/payments' },
  { file: 'server/api/payments.routes.ts', router: 'paymentActionRoutes', prefix: '/api' },
  { file: 'server/api/delivery.routes.ts', router: 'deliveryRoutes', prefix: '/api' },
  { file: 'server/api/operations.routes.ts', router: 'operationsRoutes', prefix: '/api' },
  { file: 'server/api/import.routes.ts', router: 'importRoutes', prefix: '/api' },
];

const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
type Operation = `${(typeof methods)[number]} ${string}`;

const registered = new Set<Operation>();

// These three are declared directly on the app rather than on a router.
registered.add('get /api/health');
registered.add('get /api/config');
registered.add('get /api/metrics');

for (const { file, router, prefix } of routeFiles) {
  const source = await readFile(file, 'utf8');
  const pattern = new RegExp(`\\b${router}\\.(${methods.join('|')})\\(\\s*['"]([^'"]+)['"]`, 'g');
  for (const match of source.matchAll(pattern)) {
    const path = (prefix + match[2]).replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    registered.add(`${match[1]} ${path}` as Operation);
  }
}

const spec = parse(await readFile('openapi.yaml', 'utf8')) as {
  paths: Record<string, Record<string, unknown>>;
};

const documented = new Set<Operation>();
for (const [path, pathItem] of Object.entries(spec.paths))
  for (const method of methods)
    if (pathItem[method]) documented.add(`${method} ${path}` as Operation);

const missing = [...registered].filter((operation) => !documented.has(operation)).sort();
const extra = [...documented].filter((operation) => !registered.has(operation)).sort();

console.log(`Registered operations: ${registered.size}`);
console.log(`Documented operations: ${documented.size}`);
if (missing.length) console.error('Missing from openapi.yaml:\n  ' + missing.join('\n  '));
if (extra.length) console.error('Not registered by any router:\n  ' + extra.join('\n  '));
if (missing.length || extra.length) process.exit(1);
console.log('OpenAPI paths match the registered routes.');
