import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

test('restaurant rejects a confirmed order with a reason and sees the refund state', async ({
  page,
}) => {
  const schema = process.env.E2E_SCHEMA;
  if (!schema || !/^e2e_[a-f0-9]{32}$/.test(schema) || !process.env.TEST_DATABASE_URL)
    throw new Error('An isolated E2E schema is required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
  const order = randomUUID();
  try {
    expect((await pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema);
    await pool.query(
      `INSERT INTO orders (id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at) VALUES ($1,'customer','mock-restaurant-01','CONFIRMED',1000,0,1000,'Test address',$2,'test',now()+interval '10 minutes')`,
      [order, `rejection-${order}`],
    );
    await pool.query(
      "INSERT INTO payments (id,order_id,reference,amount,status) VALUES ($1,$2,$3,1000,'SUCCEEDED')",
      [randomUUID(), order, `rejection-${order}`],
    );
    await pool.query("INSERT INTO deliveries (id,order_id,status) VALUES ($1,$2,'UNASSIGNED')", [
      randomUUID(),
      order,
    ]);
    await page.setViewportSize({ width: 375, height: 900 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Email', { exact: true }).fill('restaurant@bep.local');
    await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('link', { name: 'Orders', exact: true }).click();
    const card = page.locator('.order-card').filter({ hasText: order.slice(0, 8).toUpperCase() });
    await expect(card.getByRole('button', { name: 'Accepted' })).toBeVisible();
    await card.getByText('Reject this order').click();
    await card.getByLabel('Reason for rejection').fill('Kitchen unavailable');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await card.getByRole('button', { name: 'Confirm rejection' }).click();
    await expect(card.locator('.status').first()).toHaveText('Cancelled');
    await expect(card).toContainText('Refund pending');
    expect(
      (await pool.query('SELECT status FROM orders WHERE id = $1', [order])).rows[0].status,
    ).toBe('CANCELLED');
  } finally {
    await pool.end();
  }
});
