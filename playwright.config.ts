import { defineConfig } from '@playwright/test';
import { randomUUID } from 'node:crypto';
process.env.E2E_SCHEMA = 'e2e_' + randomUUID().replaceAll('-', '');
export default defineConfig({
  globalTeardown: './scripts/e2e-cleanup.ts',
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: 'http://127.0.0.1:5174',
    channel: 'chrome',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'npx tsx scripts/e2e-server.ts',
      url: 'http://127.0.0.1:3002/api/health',
      reuseExistingServer: false,
      timeout: 30000,
    },
    {
      command: 'npx vite --host 127.0.0.1 --port 5174 --strictPort',
      url: 'http://127.0.0.1:5174',
      env: { VITE_API_TARGET: 'http://127.0.0.1:3002' },
      reuseExistingServer: false,
    },
  ],
  reporter: 'list',
});
