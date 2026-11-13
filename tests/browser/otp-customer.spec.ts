import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

test('customer can safely recover from a lost OTP creation response', async ({ page }) => {
  const schema = process.env.E2E_SCHEMA;
  if (!schema || !/^e2e_[a-f0-9]{32}$/.test(schema) || !process.env.TEST_DATABASE_URL)
    throw new Error('An isolated E2E schema is required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
  const order = randomUUID(),
    delivery = randomUUID(),
    driver = `otp-ui-${randomUUID()}`;
  try {
    expect((await pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema);
    await pool.query(
      "INSERT INTO users (id,email,name,password_hash,role,active) SELECT $1,$2,'Test driver',password_hash,'DRIVER',true FROM users WHERE id='driver'",
      [driver, `${driver}@test.local`],
    );
    await pool.query(
      "INSERT INTO orders (id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at) VALUES ($1,'customer','mock-restaurant-01','OUT_FOR_DELIVERY',1000,0,1000,'Test address',$2,'test',now()+interval '10 minutes')",
      [order, `otp-ui-${order}`],
    );
    await pool.query(
      "INSERT INTO payments (id,order_id,reference,amount,status) VALUES ($1,$2,$3,1000,'SUCCEEDED')",
      [randomUUID(), order, `otp-ui-payment-${order}`],
    );
    await pool.query(
      "INSERT INTO deliveries (id,order_id,driver_id,status) VALUES ($1,$2,$3,'PICKED_UP')",
      [delivery, order, driver],
    );
    await pool.query(
      'INSERT INTO driver_assignments (id,delivery_id,driver_id,active) VALUES ($1,$2,$3,true)',
      [randomUUID(), delivery, driver],
    );
    let first = true;
    const keys: string[] = [];
    await page.route(`**/api/orders/${order}/delivery-proof/otp`, async (route) => {
      keys.push(route.request().postDataJSON().idempotencyKey);
      const response = await route.fetch();
      if (first) {
        first = false;
        await route.abort('failed');
      } else await route.fulfill({ response });
    });
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Email', { exact: true }).fill('customer@bep.local');
    await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('link', { name: 'Orders', exact: true }).click();
    const card = page.locator('.order-card').filter({ hasText: order.slice(0, 8).toUpperCase() });
    const section = card.getByLabel('Delivery code');
    await section.getByRole('button', { name: 'Generate delivery code' }).click();
    await expect(section.getByRole('alert')).toBeVisible();
    await section.getByRole('button', { name: 'Retry code request' }).click();
    await expect(section).toContainText('cannot be shown again');
    assertSame(keys[0], keys[1]);
    await section.getByRole('button', { name: 'Generate a new code' }).click();
    await expect(section).toContainText(/Your delivery code: \d{6}/);
    expect(keys[2]).not.toBe(keys[1]);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    const statuses = await pool.query(
      'SELECT status FROM delivery_otp_challenges WHERE order_id=$1 ORDER BY created_at',
      [order],
    );
    expect(statuses.rows.map((row) => row.status)).toEqual(['REVOKED', 'ACTIVE']);
  } finally {
    await pool.end();
  }
});

function assertSame(first: string, second: string) {
  expect(first).toBe(second);
}
