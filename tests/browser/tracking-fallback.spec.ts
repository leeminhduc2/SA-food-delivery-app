import { expect, test } from '@playwright/test';

test('notification stream stuck connecting keeps polling and is closed on logout', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const state = window as any;
    state.testClosedStreams = 0;
    class ConnectingEventSource extends EventTarget {
      readyState = 0;
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      close() {
        this.readyState = 2;
        state.testClosedStreams++;
      }
    }
    Object.defineProperty(window, 'EventSource', {
      configurable: true,
      value: ConnectingEventSource,
    });
  });
  let orderReads = 0;
  page.on('request', (request) => {
    if (request.method() === 'GET' && new URL(request.url()).pathname === '/api/orders')
      orderReads++;
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill('customer@bep.local');
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => orderReads, { timeout: 15000 }).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect
    .poll(() => page.evaluate(() => (window as any).testClosedStreams))
    .toBeGreaterThan(0);
});
