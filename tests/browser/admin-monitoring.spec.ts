import { expect, test } from '@playwright/test';

test('admin monitoring filters, timeline, acknowledgement and responsive fallback', async ({
  page,
}) => {
  let failRequests = true;
  let acknowledged = false;
  let retryBody: any;
  let reassignBody: any;
  await page.route('**/api/admin/assignments/search-test/retry', (route) => {
    retryBody = route.request().postDataJSON();
    return route.fulfill({ json: { searchId: 'search-next', generation: 2 } });
  });
  await page.route('**/api/admin/deliveries/delivery-test/reassign', (route) => {
    reassignBody = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, assignmentId: 'assignment-next' } });
  });
  await page.route('**/api/admin/monitoring/summary', (route) =>
    route.fulfill({
      json: {
        online: 2,
        ready: 1,
        busy: 1,
        pendingSearches: 2,
        pendingPayments: 3,
        heartbeatMaxAgeSeconds: 90,
      },
    }),
  );
  await page.route('**/api/admin/alerts', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            kind: 'EXHAUSTED',
            resourceId: 'search-test',
            deliveryId: 'delivery-test',
            reason: 'ROUNDS_EXHAUSTED',
            acknowledgedAt: acknowledged ? '2026-01-01T00:00:00Z' : null,
          },
        ],
      },
    }),
  );
  await page.route('**/api/admin/alerts/EXHAUSTED/search-test/acknowledge', (route) => {
    acknowledged = true;
    return route.fulfill({
      json: { acknowledgedAt: '2026-01-01T00:00:00Z', acknowledgedBy: 'admin' },
    });
  });
  await page.route('**/api/admin/assignments/search-test', (route) =>
    route.fulfill({
      json: {
        searchId: 'search-test',
        deliveryId: 'delivery-test',
        status: 'EXHAUSTED',
        generation: 1,
        round: 3,
        offersCreated: 1,
        deadlineAt: '2026-01-01T00:10:00Z',
        nextRunAt: '2026-01-01T00:01:00Z',
        attempts: [
          {
            attemptId: 'attempt-1',
            driverId: 'driver-a',
            round: 1,
            outcome: 'REJECTED',
            reason: 'BUSY',
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
        events: [
          {
            id: 'event-1',
            round: 2,
            event: 'RETRY_SCHEDULED',
            reason: 'NO_CANDIDATE',
            createdAt: '2026-01-01T00:00:00Z',
            nextRunAt: '2026-01-01T00:01:00Z',
          },
        ],
      },
    }),
  );
  await page.route('**/api/admin/assignments?*', (route) => {
    if (failRequests) {
      return route.fulfill({ status: 503, json: { message: 'Monitoring unavailable' } });
    }
    const url = new URL(route.request().url());
    const match =
      !url.searchParams.get('orderId') || url.searchParams.get('orderId') === 'order-test';
    return route.fulfill({
      json: {
        items: match
          ? [
              {
                searchId: 'search-test',
                orderId: 'order-test',
                deliveryId: 'delivery-test',
                status: 'EXHAUSTED',
                generation: 1,
                round: 3,
                offersCreated: 1,
              },
            ]
          : [],
        nextCursor: null,
      },
    });
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill('admin@bep.local');
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('link', { name: 'Operations', exact: true }).click();
  const panel = page.locator('.assignment-monitoring');
  await expect(panel.getByRole('alert')).toContainText('Monitoring unavailable');
  failRequests = false;
  await panel.getByRole('button', { name: 'Try again' }).click();
  await expect(panel).toContainText('pending payments');
  await panel.getByLabel('Order ID').fill('order-test');
  await panel.getByLabel('Driver ID').fill('driver-a');
  await panel.getByRole('button', { name: 'Apply filters' }).focus();
  await page.keyboard.press('Enter');
  await expect(panel).toContainText('Order order-test');
  await panel.getByRole('button', { name: 'View search details' }).click();
  await expect(panel.getByLabel('Search details')).toContainText('Driver driver-a');
  await expect(panel.getByLabel('Search details')).toContainText('No candidate');
  await panel.getByLabel('Reason', { exact: true }).fill('Operations review');
  await panel.getByRole('button', { name: 'Retry search' }).click();
  await expect.poll(() => retryBody?.reason).toBe('Operations review');
  await expect(panel.getByLabel('Search details')).toContainText('Driver driver-a');
  await panel.getByLabel('Reason', { exact: true }).fill('Driver unavailable');
  await panel.getByLabel('Replacement driver ID').fill('driver-b');
  await panel.getByRole('combobox', { name: 'Exception' }).selectOption('DRIVER_UNAVAILABLE');
  await panel.getByRole('button', { name: 'Assign replacement driver' }).click();
  await expect.poll(() => reassignBody?.driverId).toBe('driver-b');
  expect(reassignBody.exceptionCode).toBe('DRIVER_UNAVAILABLE');
  await panel.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(panel).toContainText('Acknowledged');
  for (const width of [375, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  }
  await panel.getByLabel('Order ID').fill('missing');
  await panel.getByRole('button', { name: 'Apply filters' }).click();
  await expect(panel).toContainText('No assignment searches match these filters.');
});
