import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
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
  await page.getByRole('link', { name: 'Orders', exact: true }).click();
}

// Legacy orders created before the payment/delivery flow may have no payment or
// delivery row at all. The API omits those keys, so the card must render a
// clear fallback instead of crashing the whole order list.
test('order cards without payment or delivery records render instead of crashing', async ({
  page,
}) => {
  const pool = new pg.Pool({ connectionString: isolatedUrl(), connectionTimeoutMillis: 3000 });
  const accepted = randomUUID(),
    delivered = randomUUID(),
    delivery = randomUUID();
  try {
    expect((await pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(
      process.env.E2E_SCHEMA,
    );
    await pool.query(
      `INSERT INTO orders (id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at)
       VALUES ($1,'customer','mock-restaurant-01','ACCEPTED',1000,10000,11000,'Private test address',$2,'test',now()+interval '10 minutes')`,
      [accepted, `legacy-accepted-${accepted}`],
    );
    await pool.query("INSERT INTO deliveries (id,order_id,status) VALUES ($1,$2,'UNASSIGNED')", [
      delivery,
      accepted,
    ]);
    await pool.query(
      `INSERT INTO orders (id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at)
       VALUES ($1,'customer','mock-restaurant-01','DELIVERED',1000,0,1000,'Private test address',$2,'test',now()+interval '10 minutes')`,
      [delivered, `legacy-delivered-${delivered}`],
    );
    const errors: Error[] = [];
    page.on('pageerror', (error) => errors.push(error));
    await login(page, 'customer');
    const acceptedCard = page
      .locator('.order-card')
      .filter({ hasText: `ORDER #${accepted.slice(0, 8).toUpperCase()}` });
    const deliveredCard = page
      .locator('.order-card')
      .filter({ hasText: `ORDER #${delivered.slice(0, 8).toUpperCase()}` });
    await expect(acceptedCard).toHaveCount(1);
    await expect(acceptedCard).toContainText('No payment record');
    await expect(acceptedCard).toContainText('Unassigned');
    await expect(deliveredCard).toHaveCount(1);
    await expect(deliveredCard).toContainText('No payment record');
    await expect(deliveredCard).toContainText('No delivery record');
    // No payment means no refund request can be made from the card.
    await expect(deliveredCard.getByText('Request a full refund')).toHaveCount(0);
    // The timeline disclosure still expands without payment data.
    await acceptedCard.getByRole('button', { name: 'View order timeline' }).click();
    await expect(acceptedCard.locator('.timeline')).toBeAttached();
    expect(errors).toEqual([]);
  } finally {
    await pool.end();
  }
});
