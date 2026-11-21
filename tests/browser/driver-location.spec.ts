import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, role: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill(`${role}@bep.local`);
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('driver location requests permission, reports rate limiting and stops on demand', async ({
  page,
}) => {
  test.setTimeout(60000);
  await page.addInitScript(() => {
    const state = window as any;
    state.geoCleared = 0;
    state.geoOk = null;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (ok: (position: unknown) => void) => {
          state.geoOk = ok;
          return 33;
        },
        clearWatch: () => {
          state.geoCleared++;
        },
      },
    });
  });
  let posts = 0;
  let limited = true;
  await page.route('**/api/driver/location', (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    posts++;
    if (limited) {
      limited = false;
      return route.fulfill({
        status: 429,
        json: {
          code: 'LOCATION_RATE_LIMITED',
          message: 'Location updates are limited to one every 5 seconds.',
        },
      });
    }
    return route.continue();
  });
  await login(page, 'driver');
  await page.getByRole('link', { name: 'My deliveries' }).click();
  const panel = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Driver availability' }) });
  // Sharing starts automatically after sign-in; nothing needs to be clicked.
  await expect(panel).toContainText(/Requesting location permission|Acquiring location/);
  await expect(panel.getByRole('button', { name: 'Stop sharing location' })).toBeVisible();

  // Nothing is marked active before the backend confirms the first position.
  await page.evaluate(() =>
    (window as any).geoOk({
      coords: { latitude: 21.03, longitude: 105.85 },
      timestamp: Date.now(),
    }),
  );
  await expect(panel.getByRole('alert')).toContainText('rate limited');
  await expect(panel).toContainText('Location error.');
  await expect(panel).not.toContainText('Location is active.');

  // The watcher stays alive and the next fix (after the 10 s client throttle)
  // is accepted by the real endpoint.
  await page.waitForTimeout(10500);
  await page.evaluate(() =>
    (window as any).geoOk({
      coords: { latitude: 21.0301, longitude: 105.8501 },
      timestamp: Date.now(),
    }),
  );
  await expect(panel).toContainText('Location is active.');
  await expect(panel).toContainText('Location is recent');
  expect(posts).toBe(2);

  await panel.getByRole('button', { name: 'Stop sharing location' }).click();
  await expect(panel).toContainText('Location sharing is off');
  await expect.poll(() => page.evaluate(() => (window as any).geoCleared)).toBeGreaterThan(0);
  const afterStop = posts;
  await page.evaluate(() =>
    (window as any).geoOk({
      coords: { latitude: 21.04, longitude: 105.86 },
      timestamp: Date.now() + 20000,
    }),
  );
  await page.waitForTimeout(300);
  expect(posts).toBe(afterStop);
});
