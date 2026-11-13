/**
 * Static checks that keep server/ a modular monolith. No database needed.
 * The rules are described in docs/DECISIONS.md ("Module boundaries").
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { test } from 'node:test';

const SERVER = 'server';

type SourceFile = { path: string; source: string };

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

const posix = (path: string) => path.split(sep).join('/');
const files: SourceFile[] = walk(SERVER).map((path) => ({
  path: posix(relative(SERVER, path)),
  source: readFileSync(path, 'utf8'),
}));

/** `catalog` for modules/catalog/**, otherwise null (shared, seed, app.ts, modules/index.tsâ€¦). */
function moduleOf(path: string): string | null {
  const parts = path.split('/');
  return parts[0] === 'modules' && parts.length > 2 ? parts[1] : null;
}

/** Relative import specifiers resolved to server-relative .ts paths. */
function importsOf(file: SourceFile): string[] {
  const found: string[] = [];
  for (const match of file.source.matchAll(/(?:from\s+|import\s*\(\s*)['"](\.[^'"]+)['"]/g))
    found.push(posix(normalize(join(dirname(file.path), match[1]))).replace(/\.js$/, '.ts'));
  return found;
}

function packagesOf(file: SourceFile): string[] {
  return [...file.source.matchAll(/from\s+['"]([^.'"][^'"]*)['"]/g)].map((match) => match[1]);
}

test('modules import each other only through index.ts', () => {
  const violations: string[] = [];
  for (const file of files) {
    const from = moduleOf(file.path);
    for (const target of importsOf(file)) {
      const to = moduleOf(target);
      if (!to || to === from) continue;
      if (target !== `modules/${to}/index.ts`) violations.push(`${file.path} -> ${target}`);
    }
  }
  assert.deepEqual(violations, [], 'Import the module public API (index.ts) instead');
});

test('shared/ does not depend on any module', () => {
  const violations = files
    .filter((file) => file.path.startsWith('shared/'))
    .flatMap((file) =>
      importsOf(file)
        .filter((target) => target.startsWith('modules/'))
        .map((target) => `${file.path} -> ${target}`),
    );
  assert.deepEqual(violations, []);
});

test('domain/ code is pure: no database, infrastructure or HTTP', () => {
  const violations: string[] = [];
  for (const file of files.filter((f) => f.path.includes('/domain/'))) {
    for (const target of importsOf(file))
      if (target === 'shared/db.ts' || target.includes('/infrastructure/'))
        violations.push(`${file.path} -> ${target}`);
    for (const pkg of packagesOf(file))
      if (pkg === 'express' || pkg.startsWith('@prisma/'))
        violations.push(`${file.path} -> ${pkg}`);
  }
  assert.deepEqual(violations, []);
});

test('the module dependency graph has no cycles', () => {
  const edges = new Map<string, Set<string>>();
  for (const file of files) {
    const from = moduleOf(file.path);
    if (!from) continue;
    for (const target of importsOf(file)) {
      const to = moduleOf(target);
      if (to && to !== from) {
        if (!edges.has(from)) edges.set(from, new Set());
        edges.get(from)!.add(to);
      }
    }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const cycles: string[] = [];
  const visit = (node: string, trail: string[]) => {
    if (state.get(node) === 'done') return;
    if (state.get(node) === 'visiting') {
      cycles.push([...trail.slice(trail.indexOf(node)), node].join(' -> '));
      return;
    }
    state.set(node, 'visiting');
    for (const next of edges.get(node) ?? []) visit(next, [...trail, node]);
    state.set(node, 'done');
  };
  for (const node of edges.keys()) visit(node, []);
  assert.deepEqual(cycles, [], 'Use a domain event or a port instead of a back-reference');
});

/** Prisma model (delegate name) and table name -> owning module. */
const owners: Record<string, { tables: string[]; models: string[] }> = {
  identity: { models: ['user', 'session'], tables: ['users', 'sessions'] },
  catalog: {
    models: [
      'restaurant',
      'restaurantMember',
      'menu',
      'menuItem',
      'restaurantImportJob',
      'stockMovement',
    ],
    tables: [
      'restaurants',
      'restaurant_members',
      'menus',
      'menu_items',
      'restaurant_import_jobs',
      'stock_movements',
    ],
  },
  location: { models: ['address', 'driverLocation'], tables: ['addresses', 'driver_locations'] },
  assignment: {
    models: [
      'driverAvailability',
      'driverOperationalChange',
      'assignmentSearch',
      'driverOffer',
      'assignmentAttempt',
    ],
    tables: [
      'driver_availability',
      'driver_operational_changes',
      'assignment_searches',
      'driver_offers',
      'assignment_attempts',
    ],
  },
  ordering: { models: ['order', 'orderItem', 'cart'], tables: ['orders', 'order_items', 'carts'] },
  payment: {
    models: ['payment', 'paymentEvent', 'simulatedTransaction'],
    tables: ['payments', 'payment_events', 'simulated_transactions'],
  },
  delivery: {
    models: [
      'delivery',
      'driverAssignment',
      'deliveryIncident',
      'deliveryIncidentHistory',
      'deliveryOtpChallenge',
      'deliveryOtpAttempt',
      'deliveryProof',
      'deliveryProofUpload',
    ],
    tables: [
      'deliveries',
      'driver_assignments',
      'delivery_incidents',
      'delivery_incident_history',
      'delivery_otp_challenges',
      'delivery_otp_attempts',
      'delivery_proofs',
      'delivery_proof_uploads',
    ],
  },
  notification: { models: ['notification', 'outbox'], tables: ['notifications', 'outbox'] },
  review: {
    models: ['review', 'reviewReply', 'reviewReplyRevision', 'reviewModerationRequest'],
    tables: ['reviews', 'review_replies', 'review_reply_revisions', 'review_moderation_requests'],
  },
  support: {
    models: ['complaint', 'complaintHistory'],
    tables: ['complaints', 'complaint_history'],
  },
  // Written through shared/audit.repository.ts by every module.
  shared: { models: ['auditLog', 'stateHistory'], tables: ['audit_logs', 'state_history'] },
};
const modelOwner = new Map<string, string>();
const tableOwner = new Map<string, string>();
for (const [module, owned] of Object.entries(owners)) {
  owned.models.forEach((model) => modelOwner.set(model, module));
  owned.tables.forEach((table) => tableOwner.set(table, module));
}

/** Read-only projections allowed to read other modules' tables (docs/DECISIONS.md). */
const projectionExceptions = [
  /\.projection\.ts$/,
  /^modules\/backoffice\/report\.repository\.ts$/,
  /^modules\/catalog\/infrastructure\/catalog-archive\.repository\.ts$/,
];

test('each module reads and writes only the tables it owns', () => {
  const violations: string[] = [];
  for (const file of files) {
    const module = moduleOf(file.path);
    if (!module || projectionExceptions.some((rule) => rule.test(file.path))) continue;
    const touched: Array<[kind: string, name: string, owner: string | undefined]> = [];
    for (const match of file.source.matchAll(/\b(?:db|prisma|tx)\.([a-z][A-Za-z]+)\.[a-zA-Z]+\(/g))
      touched.push(['model', match[1], modelOwner.get(match[1])]);
    for (const match of file.source.matchAll(/lockRow\(\s*\w+,\s*'([a-z_]+)'/g))
      touched.push(['lock', match[1], tableOwner.get(match[1])]);
    for (const match of file.source.matchAll(/\b(?:FROM|JOIN|UPDATE|INTO)\s+"?([a-z_]+)"?/g))
      if (tableOwner.has(match[1])) touched.push(['sql', match[1], tableOwner.get(match[1])]);
    for (const [kind, name, owner] of touched)
      if (owner && owner !== module && owner !== 'shared')
        violations.push(`${file.path}: ${kind} ${name} belongs to ${owner}`);
  }
  assert.deepEqual(
    [...new Set(violations)],
    [],
    "Call the owning module's public API, or move a read-only query into a *.projection.ts",
  );
});
