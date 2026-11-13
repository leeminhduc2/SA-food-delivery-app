import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import pg from 'pg';

function isolatedUrl() {
  const schema = process.env.E2E_SCHEMA;
  if (!schema || !/^e2e_[a-f0-9]{32}$/.test(schema) || !process.env.TEST_DATABASE_URL)
    throw new Error('An isolated E2E schema is required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}
async function login(page: Page, role: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill(`${role}@bep.local`);
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .getByRole('link', { name: role === 'driver' ? 'My deliveries' : 'Orders', exact: true })
    .click();
}

test('tracking shows clear fallback, walking routes, freshness, keyboard and cleanup', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const pool = new pg.Pool({ connectionString: isolatedUrl(), connectionTimeoutMillis: 3000 });
  const id = randomUUID(),
    delivery = randomUUID();
  const contexts = [];
  try {
    assertSchema((await pool.query('SELECT current_schema() AS schema')).rows[0].schema);
    await pool.query(
      `INSERT INTO orders (id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at,delivery_latitude,delivery_longitude)
      VALUES ($1,'customer','mock-restaurant-01','ACCEPTED',1000,10000,11000,'Private test address',$2,'test',now()+interval '10 minutes',21.035,105.86)`,
      [id, `ui-${id}`],
    );
    await pool.query(
      "INSERT INTO payments (id,order_id,reference,amount,status) VALUES ($1,$2,$3,11000,'SUCCEEDED')",
      [randomUUID(), id, `ui-payment-${id}`],
    );
    await pool.query("INSERT INTO deliveries (id,order_id,status) VALUES ($1,$2,'UNASSIGNED')", [
      delivery,
      id,
    ]);
    await pool.query(`INSERT INTO driver_locations (driver_id,latitude,longitude,captured_at,received_at) VALUES ('driver',21.0301,105.8527,now(),now())
      ON CONFLICT (driver_id) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude,captured_at=excluded.captured_at,received_at=excluded.received_at,version=driver_locations.version+1`);
    const customerContext = await browser.newContext();
    contexts.push(customerContext);
    await customerContext.addInitScript(() => {
      const state = window as any;
      state.trackingOpened = 0;
      state.trackingClosed = 0;
      state.trackingInstances = [];
      const Native = window.EventSource;
      class Connecting extends EventTarget {
        readyState = 0;
        onerror: (() => void) | null = null;
        onopen: (() => void) | null = null;
        private closed = false;
        constructor() {
          super();
          state.trackingOpened++;
          state.trackingInstances.push(this);
        }
        close() {
          if (!this.closed) {
            this.closed = true;
            this.readyState = 2;
            state.trackingClosed++;
          }
        }
      }
      Object.defineProperty(window, 'EventSource', {
        configurable: true,
        value: function (url: string, options?: EventSourceInit) {
          return String(url).includes('/tracking/stream')
            ? new Connecting()
            : new Native(url, options);
        },
      });
    });
    const customer = await customerContext.newPage();
    await login(customer, 'customer');
    const card = customer
      .locator('.order-card')
      .filter({ hasText: `ORDER #${id.slice(0, 8).toUpperCase()}` });
    await expect(card).toHaveCount(1);
    const summary = card.locator('summary').filter({ hasText: 'Track delivery' });
    await summary.focus();
    await customer.keyboard.press('Enter');
    const tracking = card.getByRole('region', { name: 'Delivery tracking' });
    await expect(tracking).toContainText('A driver has not been assigned yet.');
    await expect(tracking).toContainText('No live driver position');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE deliveries SET status='ASSIGNED',driver_id='driver' WHERE id=$1", [
        delivery,
      ]);
      await client.query(
        "INSERT INTO driver_assignments(id,delivery_id,driver_id,active) VALUES ($1,$2,'driver',true)",
        [randomUUID(), delivery],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await summary.click();
    await summary.click();
    await expect(tracking).toContainText('Driver: Đức Lê');
    await expect(tracking).toContainText('21.03010');
    await expect(tracking.locator('.map-canvas')).toBeVisible();
    for (const width of [375, 768, 1024, 1440]) {
      await customer.setViewportSize({ width, height: 900 });
      expect(
        await customer.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBeTruthy();
    }
    await pool.query(
      "UPDATE driver_locations SET latitude=21.031,captured_at=now(),received_at=now(),version=version+1 WHERE driver_id='driver'",
    );
    await expect(tracking).toContainText('21.03100', { timeout: 20000 });
    await summary.click();
    await expect
      .poll(() => customer.evaluate(() => (window as any).trackingClosed))
      .toBeGreaterThan(0);
    await summary.click();
    await expect(tracking).toContainText('21.03100');
    await customer.evaluate((orderId) => {
      const stream = (window as any).trackingInstances.at(-1);
      stream.dispatchEvent(new MessageEvent('revoked', { data: '{}' }));
      stream.dispatchEvent(
        new MessageEvent('location', {
          data: JSON.stringify({
            orderId,
            status: 'ASSIGNED',
            driver: { id: 'old', name: 'Old driver' },
            location: { latitude: 0, longitude: 0 },
            capturedAt: new Date().toISOString(),
            stale: false,
            reason: null,
          }),
        }),
      );
    }, id);
    await expect(tracking).toContainText('21.03100');
    await expect(tracking).not.toContainText('0.00000');
    for (const role of ['restaurant', 'admin']) {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      await login(page, role);
      const roleCard = page
        .locator('.order-card')
        .filter({ hasText: `ORDER #${id.slice(0, 8).toUpperCase()}` });
      await roleCard.locator('summary').filter({ hasText: 'Track delivery' }).click();
      await expect(roleCard.getByRole('region', { name: 'Delivery tracking' })).toContainText(
        'Driver: Đức Lê',
      );
      await expect(
        roleCard.getByRole('region', { name: 'Delivery tracking' }).locator('.map-canvas'),
      ).toBeVisible();
    }
    const driverContext = await browser.newContext();
    contexts.push(driverContext);
    const driver = await driverContext.newPage();
    await driver.route('**/tile.openstreetmap.org/**', (route) => route.abort());
    let routeCalls = 0;
    await driver.route('**/tracking/route?*', async (route) => {
      routeCalls++;
      if (routeCalls === 1)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({
            code: 'ROUTE_UNAVAILABLE',
            message: 'Walking directions are unavailable. Please try again.',
          }),
        });
      else await route.continue();
    });
    await login(driver, 'driver');
    const driverCard = driver
      .locator('.order-card')
      .filter({ hasText: `ORDER #${id.slice(0, 8).toUpperCase()}` });
    const driverSummary = driverCard.locator('summary').filter({ hasText: 'Track delivery' });
    await driverSummary.click();
    const driverTracking = driverCard.getByRole('region', { name: 'Delivery tracking' });
    await expect(driverTracking).toContainText('21.03100');
    await driverTracking.getByRole('button', { name: 'Get walking route' }).click();
    await expect(driverTracking.getByRole('alert')).toContainText(
      'Walking directions are unavailable',
    );
    await expect(driverTracking.getByText(/km · about/)).toHaveCount(0);
    await driverTracking.getByRole('button', { name: 'Retry directions' }).click();
    await expect(driverTracking).toContainText('Walking route to');
    await expect(driverTracking).toContainText('1.2 km');
    const destination = driverTracking.getByLabel('Walking destination');
    await destination.focus();
    await driver.keyboard.press('End');
    await expect(destination).toHaveValue('dropoff');
    await driver.keyboard.press('Tab');
    await expect(driverTracking.getByRole('button', { name: 'Get walking route' })).toBeFocused();
    await driver.keyboard.press('Enter');
    await expect(driverTracking).toContainText('Walking route to Drop-off');
    await pool.query(
      "UPDATE driver_locations SET latitude=21.032,captured_at=now(),received_at=now(),version=version+1 WHERE driver_id='driver'",
    );
    await expect(driverTracking).toContainText("The driver's position changed.", {
      timeout: 20000,
    });
    await driverTracking.getByRole('button', { name: 'Refresh walking route' }).click();
    await expect(driverTracking).not.toContainText("The driver's position changed.");
    await expect(driverTracking).toContainText('Map tiles are unavailable.');
    await driverTracking.getByRole('button', { name: 'Retry map' }).click();
    await expect(driverTracking).toContainText('Map tiles are unavailable.');
    await mkdir('test-results', { recursive: true });
    for (const width of [375, 768, 1440]) {
      await driver.setViewportSize({ width, height: 900 });
      expect(
        await driver.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBeTruthy();
      if (width === 375 || width === 1440)
        await driverCard.screenshot({ path: `test-results/tracking-driver-${width}.png` });
    }
    await pool.query(
      "UPDATE driver_locations SET captured_at=now()-interval '2 minutes',received_at=now()-interval '2 minutes' WHERE driver_id='driver'",
    );
    await expect(driverTracking.getByText(/Last known location:.*out of date/)).toBeVisible({
      timeout: 20000,
    });
    await expect(driverTracking.getByText(/Walking route to Drop-off:/)).toHaveCount(0);
    await expect(driverTracking.getByRole('button', { name: 'Get walking route' })).toBeDisabled();
    await pool.query("DELETE FROM driver_locations WHERE driver_id='driver'");
    await driverSummary.click();
    await driverSummary.click();
    await expect(driverTracking).toContainText('No live driver position to show on the map.');
    await expect(driverTracking.locator('.map-canvas')).toHaveCount(0);
    await customer.evaluate(() => {
      const stream = (window as any).trackingInstances.at(-1);
      stream.dispatchEvent(
        new MessageEvent('tracking_status', {
          data: JSON.stringify({ status: 'DELIVERED', reason: 'TERMINAL' }),
        }),
      );
    });
    await expect(tracking).toContainText('Delivery ended');
    await expect(tracking.locator('.map-canvas')).toHaveCount(0);
    const beforeNavigation = await customer.evaluate(() => (window as any).trackingOpened);
    await customer.getByRole('link', { name: 'Discover', exact: true }).click();
    await expect
      .poll(() => customer.evaluate(() => (window as any).trackingClosed))
      .toBe(beforeNavigation);
    await expect(customer.getByRole('region', { name: 'Delivery tracking' })).toHaveCount(0);
    await customer.getByRole('link', { name: 'Orders', exact: true }).click();
    await card.locator('summary').filter({ hasText: 'Track delivery' }).click();
    await expect(tracking).toContainText('No live driver position');
    const opened = await customer.evaluate(() => (window as any).trackingOpened);
    await customer.getByRole('button', { name: 'Account settings' }).click();
    await customer.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
    await expect.poll(() => customer.evaluate(() => (window as any).trackingClosed)).toBe(opened);
    await expect(customer.getByRole('region', { name: 'Delivery tracking' })).toHaveCount(0);
  } finally {
    await pool.query(
      "UPDATE driver_assignments SET active=false,end_reason='REASSIGNED',ended_at=now() WHERE delivery_id=$1 AND active",
      [delivery],
    );
    await Promise.all(contexts.map((context) => context.close()));
    await pool.end();
  }
});
function assertSchema(actual: string) {
  if (actual !== process.env.E2E_SCHEMA) throw new Error('E2E schema mismatch');
}
