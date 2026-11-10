/**
 * SSE hub unit tests. No database or Redis: the hub is driven with fake
 * request and response objects.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, test } from 'node:test';
import {
  MAX_STREAMS_PER_USER,
  canOpenStream,
  closeAllStreams,
  dispatchPush,
  openStream,
  streamCount,
} from '../server/modules/notification/notification.stream.js';

function fakeReq(cookie = 'session=token-a'): any {
  return { headers: { cookie }, on: () => undefined };
}

function fakeRes() {
  const chunks: string[] = [];
  return {
    chunks,
    writableEnded: false,
    status() {
      return this;
    },
    set() {
      return this;
    },
    flushHeaders() {},
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
    end() {
      this.writableEnded = true;
    },
  } as any;
}

const noReplay = async () => [];

afterEach(() => closeAllStreams());

test('a push reaches only the addressed user', async () => {
  const alice = fakeRes();
  const bob = fakeRes();
  await openStream(fakeReq(), alice, 'alice', noReplay);
  await openStream(fakeReq(), bob, 'bob', noReplay);

  dispatchPush({
    id: 'n1',
    userId: 'alice',
    type: 'ORDER_STATUS',
    payload: { status: 'PREPARING' },
    created_at: new Date().toISOString(),
  });

  const aliceFrames = alice.chunks.filter((c: string) => c.includes('event: notification'));
  assert.equal(aliceFrames.length, 1);
  assert.match(aliceFrames[0], /^id: n1\nevent: notification\ndata: \{.*\}\n\n$/s);
  assert.equal(bob.chunks.filter((c: string) => c.includes('event: notification')).length, 0);
});

test('one user cannot hold more than the per-user stream limit', async () => {
  for (let i = 0; i < MAX_STREAMS_PER_USER; i++)
    await openStream(fakeReq(), fakeRes(), 'carol', noReplay);

  assert.equal(canOpenStream('carol'), 'user-limit');
  assert.equal(canOpenStream('dave'), 'ok');
});

test('closing all streams ends every response and clears the registry', async () => {
  const first = fakeRes();
  const second = fakeRes();
  await openStream(fakeReq(), first, randomUUID(), noReplay);
  await openStream(fakeReq(), second, randomUUID(), noReplay);
  assert.equal(streamCount(), 2);

  closeAllStreams();

  assert.equal(streamCount(), 0);
  assert.equal(first.writableEnded, true);
  assert.equal(second.writableEnded, true);
  assert.match(first.chunks.at(-1), /event: shutdown/);
});
