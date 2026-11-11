import type { Request, Response } from 'express';
import { resolveByToken } from '../identity/index.js';
import { tokenFrom } from '../../shared/http/actor.js';
import type { NotificationPush } from './infrastructure/redis-bus.js';

/**
 * Server-Sent Events hub. Each instance holds its own connections and
 * receives every Redis push, keeping only the ones addressed to a local user.
 */

const HEARTBEAT_MS = 25_000;
/** Re-check the session every N heartbeats: roughly every two minutes. */
const REVALIDATE_EVERY = 5;
const REPLAY_LIMIT = 100;
export const MAX_STREAMS_PER_USER = 5;
export const MAX_STREAMS_PER_INSTANCE = Number(process.env.STREAM_MAX_CONNECTIONS || 10000);

type Connection = {
  userId: string;
  token: string | undefined;
  res: Response;
  heartbeats: number;
  timer: NodeJS.Timeout;
};

const connections = new Map<string, Set<Connection>>();
let total = 0;

export function streamCount(): number {
  return total;
}

function write(res: Response, chunk: string): void {
  if (!res.writableEnded) res.write(chunk);
}

function frame(event: string, id: string | undefined, data: unknown): string {
  return (id ? `id: ${id}\n` : '') + `event: ${event}\n` + `data: ${JSON.stringify(data)}\n\n`;
}

/** Called once per Redis message. Only local subscribers are touched. */
export function dispatchPush(message: NotificationPush): void {
  const set = connections.get(message.userId);
  if (!set) return;
  const chunk = frame('notification', message.id, {
    id: message.id,
    type: message.type,
    payload: message.payload,
    created_at: message.created_at,
  });
  for (const connection of set) write(connection.res, chunk);
}

function remove(connection: Connection): void {
  const set = connections.get(connection.userId);
  if (!set?.delete(connection)) return;
  total--;
  if (!set.size) connections.delete(connection.userId);
  clearInterval(connection.timer);
}

/** Ends every open stream. Called during shutdown so `server.close()` can finish. */
export function closeAllStreams(): void {
  for (const set of [...connections.values()])
    for (const connection of [...set]) {
      write(connection.res, frame('shutdown', undefined, { reason: 'server restarting' }));
      connection.res.end();
      remove(connection);
    }
}

export function canOpenStream(userId: string): 'ok' | 'user-limit' | 'instance-limit' {
  if (total >= MAX_STREAMS_PER_INSTANCE) return 'instance-limit';
  if ((connections.get(userId)?.size ?? 0) >= MAX_STREAMS_PER_USER) return 'user-limit';
  return 'ok';
}

export type ReplayFn = (userId: string, cursorId: string) => Promise<any[] | null>;

/**
 * Opens the stream. Registers the connection before replaying, so a push
 * arriving during replay is not lost. Duplicates are possible; clients
 * de-duplicate by notification id.
 */
export async function openStream(
  req: Request,
  res: Response,
  userId: string,
  replay: ReplayFn,
): Promise<void> {
  const token = tokenFrom(req.headers.cookie);
  res.status(200).set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  write(res, 'retry: 3000\n\n');

  const connection: Connection = {
    userId,
    token,
    res,
    heartbeats: 0,
    timer: setInterval(() => void heartbeat(connection), HEARTBEAT_MS),
  };
  const set = connections.get(userId) ?? new Set<Connection>();
  set.add(connection);
  connections.set(userId, set);
  total++;
  req.on('close', () => remove(connection));

  const cursor = req.headers['last-event-id'];
  if (typeof cursor === 'string' && cursor) {
    const missed = await replay(userId, cursor);
    if (missed === null) {
      // Unknown cursor: the client must reload its snapshot.
      write(res, frame('resync', undefined, { reason: 'unknown cursor' }));
    } else {
      for (const row of missed.slice(0, REPLAY_LIMIT))
        write(
          res,
          frame('notification', row.id, {
            id: row.id,
            type: row.type,
            payload: row.payload,
            created_at: row.created_at,
          }),
        );
    }
  }
}

/** Keeps the connection alive and ends it when the session is no longer valid. */
async function heartbeat(connection: Connection): Promise<void> {
  if (connection.res.writableEnded) return remove(connection);
  write(connection.res, ': ping\n\n');
  connection.heartbeats++;
  if (connection.heartbeats % REVALIDATE_EVERY !== 0) return;
  try {
    const user = await resolveByToken(connection.token);
    if (user?.id === connection.userId) return;
  } catch (error) {
    // Database trouble should not drop healthy streams; try again next time.
    console.error('Stream session check failed', error);
    return;
  }
  write(connection.res, frame('revoked', undefined, { reason: 'session ended' }));
  connection.res.end();
  remove(connection);
}
