import { expect, test, type Page } from '@playwright/test';
import { spawn } from 'node:child_process';
import pg from 'pg';

test.skip(
  process.env.ASSIGNMENT_AUTOMATION_ENABLED !== 'true',
  'Requires isolated automation-enabled E2E run',
);
async function login(page: Page, role: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill(`${role}@bep.local`);
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
function isolatedUrl() {
  const schema = process.env.E2E_SCHEMA;
  if (!schema || !/^e2e_[a-f0-9]{32}$/.test(schema) || !process.env.TEST_DATABASE_URL)
    throw new Error('An isolated E2E schema and test database are required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}
async function runWorker() {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', 'tests/helpers/run-assignment-worker.ts'],
    { env: { ...process.env, DATABASE_URL: isolatedUrl(), NODE_ENV: 'test' }, stdio: 'ignore' },
  );
  expect(
    await new Promise<number | null>((resolve, reject) => {
      child.on('error', reject);
      child.on('close', resolve);
    }),
  ).toBe(0);
}

test('accepted order is offered, assigned and picked up without admin intervention', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const driverContext = await browser.newContext();
  await driverContext.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (ok: (position: unknown) => void) => {
          setTimeout(
            () => ok({ coords: { latitude: 21.0301, longitude: 105.8527 }, timestamp: Date.now() }),
            0,
          );
          return 11;
        },
        clearWatch: () => {},
      },
    });
  });
  const driver = await driverContext.newPage();
  await login(driver, 'driver');
  await driver.getByRole('link', { name: 'My deliveries' }).click();
  const availability = driver
    .locator('section')
    .filter({ has: driver.getByRole('heading', { name: 'Driver availability' }) });
  await availability.getByRole('button', { name: 'Enable location' }).click();
  await expect(availability).toContainText('Location is recent');
  await availability.getByRole('button', { name: 'Go online' }).click();
  await availability.getByRole('button', { name: 'Set ready', exact: true }).click();
  await expect(availability).toContainText('Online · Ready');

  const customerContext = await browser.newContext();
  const customer = await customerContext.newPage();
  await login(customer, 'customer');
  await customer.getByRole('button', { name: 'Account settings' }).click();
  const account = customer.getByRole('dialog');
  await account.getByLabel('Street address').fill('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội');
  await account.getByRole('button', { name: 'Find address' }).click();
  await expect(account.locator('.resolved-address')).toContainText('Hà Nội');
  await account.getByRole('button', { name: 'Save delivery address' }).click();
  await expect(account.locator('.current-address')).toContainText('18 Phố Hàng Bạc');
  await account.getByRole('button', { name: 'Close dialog' }).click();
  await customer.locator('.restaurant-card').filter({ hasText: 'Bếp Phố Hà Thành' }).click();
  await customer.getByRole('button', { name: 'Add Phở bò đặc biệt', exact: true }).click();
  await customer.getByRole('button', { name: /Basket/ }).click();
  await customer.getByRole('button', { name: 'Continue to checkout' }).click();
  await customer.getByRole('button', { name: 'Place order', exact: true }).click();
  await customer.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(customer.locator('.order-card > .between .status')).toHaveText('Confirmed');

  const kitchenContext = await browser.newContext();
  const kitchen = await kitchenContext.newPage();
  await login(kitchen, 'restaurant');
  await kitchen.getByRole('link', { name: 'Orders', exact: true }).click();
  await kitchen.getByRole('button', { name: 'Accepted', exact: true }).click();
  await expect(kitchen.locator('.order-card > .between .status')).toHaveText('Accepted');
  await runWorker();
  const offers = driver
    .locator('section')
    .filter({ has: driver.getByRole('heading', { name: 'Delivery offers' }) });
  await expect(offers.getByText('Bếp Phố Hà Thành')).toBeVisible({ timeout: 15000 });
  for (const width of [375, 768, 1024, 1440]) {
    await driver.setViewportSize({ width, height: 900 });
    expect(
      await driver.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  }
  await offers.getByRole('button', { name: 'Accept offer' }).click();
  await expect(driver.getByRole('button', { name: 'Mark arrived at pickup' })).toBeVisible();
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await login(admin, 'admin');
  await admin.getByRole('link', { name: 'Operations', exact: true }).click();
  const searches = admin
    .locator('section')
    .filter({ has: admin.getByRole('heading', { name: 'Assignment monitoring' }) });
  await expect(searches).toContainText('Assigned');
  await expect(kitchen.getByText('Your driver: Đức Lê')).toBeVisible({ timeout: 15000 });
  await driver.getByRole('button', { name: 'Mark arrived at pickup' }).click();
  await expect(kitchen.getByText(/Driver arrived at pickup/)).toBeVisible({ timeout: 15000 });
  await expect(customer.getByText(/Driver arrived at pickup/)).toBeVisible({ timeout: 15000 });
  await expect(driver.getByRole('button', { name: 'Waiting for the kitchen' })).toBeDisabled();
  await kitchen.getByRole('button', { name: 'Preparing', exact: true }).click();
  await kitchen.getByRole('button', { name: 'Ready for pickup', exact: true }).click();
  await expect(driver.getByRole('button', { name: 'Picked up', exact: true })).toBeEnabled({
    timeout: 15000,
  });
  await driver.getByRole('button', { name: 'Picked up', exact: true }).click();
  await expect(kitchen.locator('.order-card > .between .status')).toHaveText('Out for delivery', {
    timeout: 15000,
  });
  await Promise.all([
    driverContext.close(),
    customerContext.close(),
    kitchenContext.close(),
    adminContext.close(),
  ]);
});

test('offer expired on server is rejected even while countdown is positive', async ({ page }) => {
  const pool = new pg.Pool({ connectionString: isolatedUrl(), connectionTimeoutMillis: 3000 });
  try {
    const target = await pool.query('SELECT current_schema() AS schema');
    expect(target.rows[0].schema).toBe(process.env.E2E_SCHEMA);
    await pool.query(`INSERT INTO orders (id, customer_id, restaurant_id, status, subtotal, delivery_fee, total, address, idempotency_key, fingerprint, expires_at) VALUES ('e2e-expiry-order','customer','mock-restaurant-01','ACCEPTED',1000,10000,11000,'Private address','e2e-expiry-key','test',now()+interval '10 minutes');
      INSERT INTO deliveries (id,order_id) VALUES ('e2e-expiry-delivery','e2e-expiry-order');
      INSERT INTO assignment_searches (id,delivery_id,status,deadline_at,next_run_at) VALUES ('e2e-expiry-search','e2e-expiry-delivery','OFFERED',now()+interval '10 minutes',now()+interval '30 seconds');
      INSERT INTO driver_offers (id,search_id,driver_id,expires_at) VALUES ('e2e-expiry-offer','e2e-expiry-search','driver2',now()+interval '30 seconds');
      INSERT INTO assignment_attempts (id,search_id,driver_id,round,offer_id,outcome) VALUES ('e2e-expiry-attempt','e2e-expiry-search','driver2',1,'e2e-expiry-offer','OFFERED')`);
    await login(page, 'driver2');
    await page.getByRole('link', { name: 'My deliveries' }).click();
    const offers = page
      .locator('section')
      .filter({ has: page.getByRole('heading', { name: 'Delivery offers' }) });
    await expect(offers.getByRole('button', { name: 'Accept offer' })).toBeVisible();
    await expect(offers).toContainText('remaining');
    await pool.query(
      `UPDATE driver_offers SET expires_at=clock_timestamp()-interval '1 second' WHERE id='e2e-expiry-offer'`,
    );
    await offers.getByRole('button', { name: 'Accept offer' }).click();
    await expect(offers.getByRole('alert')).toContainText('expired');
    expect(
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM driver_assignments WHERE delivery_id='e2e-expiry-delivery'`,
        )
      ).rows[0].n,
    ).toBe(0);
  } finally {
    await pool.end();
  }
});
