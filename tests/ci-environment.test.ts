/**
 * Redis-backed tests skip when REDIS_URL is missing so local runs work without
 * Redis. In CI (or with REQUIRE_REDIS=1) that skip would hide lost coverage, so
 * this check fails instead and proves the configured Redis answers.
 */
import 'dotenv/config';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Redis } from 'ioredis';

const required = process.env.CI === 'true' || process.env.REQUIRE_REDIS === '1';

test(
  'Redis integration is configured and reachable when required',
  { skip: required ? false : 'Not required outside CI', timeout: 8000 },
  async () => {
    assert.ok(process.env.REDIS_URL, 'REDIS_URL must be set when Redis tests are required');
    assert.ok(process.env.TEST_DATABASE_URL, 'TEST_DATABASE_URL must be set');
    const client = new Redis(process.env.REDIS_URL!, {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 3000,
      enableOfflineQueue: false,
    });
    try {
      await client.connect();
      assert.equal(await client.ping(), 'PONG');
    } finally {
      client.disconnect();
    }
  },
);
