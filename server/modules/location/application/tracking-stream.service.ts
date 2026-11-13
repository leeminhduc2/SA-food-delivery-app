import type { Request, Response } from 'express';
import type { User } from '../../../shared/types.js';
import { tokenFrom } from '../../../shared/http/actor.js';
import { check } from '../../../shared/errors.js';
import { resolveByToken } from '../../identity/index.js';
import { trackingTransport, type TrackingTransport } from '../../notification/index.js';
import { trackingAccessGateway } from '../tracking.ports.js';
import { authorizedTrackingSnapshot, terminalTracking } from './driver-tracking.service.js';

const HEARTBEAT_MS = 3000;
const VALIDATION_TIMEOUT_MS = 1500;
export const MAX_TRACKING_STREAMS_PER_USER = 5;
export const MAX_TRACKING_STREAMS_PER_INSTANCE = 10000;
type Connection = {
  actorId: string;
  role: User['role'];
  token: string;
  orderId: string;
  assignmentId: string | null;
  driverId: string | null;
  status: string;
  res: Response;
  timer: NodeJS.Timeout;
  closed: boolean;
  busy: boolean;
  dirty: boolean;
  validation?: AbortController;
  lastLocation?: string;
};
const connections = new Set<Connection>();
let activeTransport: TrackingTransport | null = null;
let unsubscribe: (() => void) | undefined;

function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
function remove(connection: Connection): void {
  if (connection.closed) return;
  connection.closed = true;
  connection.validation?.abort();
  clearInterval(connection.timer);
  connections.delete(connection);
  if (!connections.size) {
    unsubscribe?.();
    unsubscribe = undefined;
    activeTransport = null;
  }
}
function close(connection: Connection, event?: string, data?: unknown): void {
  if (connection.closed) return;
  if (event && !connection.res.writableEnded && !connection.res.destroyed)
    connection.res.write(frame(event, data));
  remove(connection);
  if (!connection.res.writableEnded && !connection.res.destroyed) connection.res.end();
}
export function closeAllTrackingStreams(): void {
  for (const connection of [...connections])
    close(connection, 'revoked', { reason: 'SERVER_RESTART' });
}
export function trackingStreamCount(): number {
  return connections.size;
}
function write(connection: Connection, event: string, data: unknown): void {
  if (connection.closed || connection.res.writableEnded || connection.res.destroyed) {
    remove(connection);
    return;
  }
  if (!connection.res.write(frame(event, data))) close(connection);
}
function attachTransport(bus: TrackingTransport): void {
  if (activeTransport === bus && unsubscribe) return;
  unsubscribe?.();
  activeTransport = bus;
  unsubscribe = bus.subscribeLocations((message) => {
    for (const connection of connections)
      if (connection.driverId === message.driverId) schedule(connection, 'location');
  });
}
async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  external: AbortSignal,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_, reject) => {
        cancel = () => {
          controller.abort();
          reject(new Error('Tracking validation cancelled'));
        };
        if (external.aborted) cancel();
        else external.addEventListener('abort', cancel, { once: true });
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Tracking validation timeout'));
        }, VALIDATION_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (cancel) external.removeEventListener('abort', cancel);
    controller.abort();
  }
}
async function sendValidated(
  connection: Connection,
  kind: 'location' | 'heartbeat',
  external: AbortSignal,
): Promise<void> {
  const checked = await withTimeout(async (signal) => {
    const actor = await resolveByToken(connection.token);
    if (signal.aborted) return null;
    if (!actor || actor.id !== connection.actorId || actor.role !== connection.role) return null;
    const current = await authorizedTrackingSnapshot(actor, connection.orderId, signal);
    if (signal.aborted) return null;
    const actorAgain = await resolveByToken(connection.token);
    if (signal.aborted) return null;
    if (!actorAgain || actorAgain.id !== connection.actorId || actorAgain.role !== connection.role)
      return null;
    const access = await trackingAccessGateway()(actorAgain, connection.orderId, signal);
    if (signal.aborted) return null;
    if (
      access.assignmentId !== current.assignmentId ||
      access.driverId !== current.driverId ||
      (current.driverId && !access.driver)
    )
      return null;
    return current;
  }, external);
  if (connection.closed) return;
  if (!checked) {
    close(connection, 'revoked', { reason: 'ACCESS_REVOKED' });
    return;
  }
  if (terminalTracking(checked.snapshot.status)) {
    write(connection, 'tracking_status', { status: checked.snapshot.status, reason: 'TERMINAL' });
    close(connection);
    return;
  }
  if (
    checked.assignmentId !== connection.assignmentId ||
    checked.driverId !== connection.driverId ||
    checked.snapshot.reason === 'DRIVER_UNAVAILABLE' ||
    checked.snapshot.reason === 'ASSIGNMENT_CHANGED'
  ) {
    close(connection, 'revoked', { reason: 'ASSIGNMENT_CHANGED' });
    return;
  }
  const currentTransport = trackingTransport();
  if (currentTransport && currentTransport !== activeTransport) attachTransport(currentTransport);
  const locationKey = JSON.stringify([
    checked.snapshot.location,
    checked.snapshot.capturedAt,
    checked.snapshot.stale,
    checked.snapshot.reason,
  ]);
  if (kind === 'location' || locationKey !== connection.lastLocation) {
    write(connection, 'location', checked.snapshot);
    connection.lastLocation = locationKey;
  }
  if (kind === 'heartbeat') {
    write(connection, 'tracking_status', {
      status: checked.snapshot.status,
      connected: Boolean(currentTransport?.trackingReady()),
    });
  }
  connection.status = checked.snapshot.status;
}
function schedule(connection: Connection, kind: 'location' | 'heartbeat'): void {
  if (connection.closed) return;
  if (connection.busy) {
    if (kind === 'location') connection.dirty = true;
    return;
  }
  connection.busy = true;
  const validation = new AbortController();
  connection.validation = validation;
  void sendValidated(connection, kind, validation.signal)
    .catch(() => close(connection, 'revoked', { reason: 'ACCESS_REVOKED' }))
    .finally(() => {
      if (connection.validation === validation) connection.validation = undefined;
      connection.busy = false;
      if (connection.dirty && !connection.closed) {
        connection.dirty = false;
        schedule(connection, 'location');
      }
    });
}
export async function openTrackingStream(
  req: Request,
  res: Response,
  actor: User,
  orderId: string,
): Promise<void> {
  const initial = await authorizedTrackingSnapshot(actor, orderId);
  if (res.destroyed || res.writableEnded) return;
  const bus = trackingTransport();
  check(
    bus && bus.trackingReady(),
    503,
    'STREAM_UNAVAILABLE',
    'Live tracking is temporarily unavailable.',
  );
  check(
    connections.size < MAX_TRACKING_STREAMS_PER_INSTANCE &&
      [...connections].filter((entry) => entry.actorId === actor.id).length <
        MAX_TRACKING_STREAMS_PER_USER,
    429,
    'TOO_MANY_STREAMS',
    'Too many open tracking streams.',
  );
  const token = tokenFrom(req.headers.cookie);
  check(token, 401, 'UNAUTHENTICATED', 'Authentication required.');
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  const connection: Connection = {
    actorId: actor.id,
    role: actor.role,
    token,
    orderId,
    assignmentId: initial.assignmentId,
    driverId: initial.driverId,
    status: initial.snapshot.status,
    res,
    closed: false,
    busy: false,
    dirty: false,
    timer: setInterval(() => schedule(connection, 'heartbeat'), HEARTBEAT_MS),
  };
  connections.add(connection);
  req.on('close', () => remove(connection));
  res.on('close', () => remove(connection));
  attachTransport(bus);
  schedule(connection, 'location');
}
