/**
 * Redis Pub/Sub bus against a real Redis. Skipped unless REDIS_URL is set,
 * so the suite still runs on machines without Redis.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import {
  createRedisBus,
  type NotificationPush,
} from '../server/modules/notification/infrastructure/redis-bus.js';

const url = process.env.REDIS_URL;

test(
  'a published push reaches a subscriber on another connection',
  { skip: url ? false : 'REDIS_URL is not set', timeout: 8000 },
  async () => {
    const channel = `test:notifications:${randomUUID()}`;
    const publisher = createRedisBus(url!, channel);
    const subscriber = createRedisBus(url!, channel);
    try {
      const received: NotificationPush[] = [];
      subscriber.subscribe((message) => received.push(message));
      // Give SUBSCRIBE time to reach Redis before publishing.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const message: NotificationPush = {
        id: randomUUID(),
        userId: 'user-under-test',
        type: 'ORDER_STATUS',
        payload: { orderId: 'o1', status: 'PREPARING' },
        created_at: new Date().toISOString(),
      };
      await publisher.publish(message);

      const deadline = Date.now() + 2000;
      while (!received.length && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));

      assert.deepEqual(received, [message]);
    } finally {
      await Promise.all([publisher.close(), subscriber.close()]);
    }
  },
);
