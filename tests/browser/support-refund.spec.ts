import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

async function login(page: Page, email: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill(email);
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}

test('customer ticket and refund request, admin approval and restaurant reply across roles', async ({
  browser,
}) => {
  const schema = process.env.E2E_SCHEMA;
  if (!schema || !/^e2e_[a-f0-9]{32}$/.test(schema) || !process.env.TEST_DATABASE_URL)
    throw new Error('An isolated E2E schema is required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
  const order = randomUUID(),
    customer = `refund-ui-${randomUUID()}`;
  const prefix = order.slice(0, 8).toUpperCase();
  try {
    expect((await pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema);
    await pool.query(
      "INSERT INTO users (id,email,name,password_hash,role,active) SELECT $1,$2,'Refund customer',password_hash,'CUSTOMER',true FROM users WHERE id='customer'",
      [customer, `${customer}@test.local`],
    );
    await pool.query(
      "INSERT INTO orders (id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at) VALUES ($1,$2,'pizza','DELIVERED',90000,15000,105000,'Test address',$3,'test',now()+interval '10 minutes')",
      [order, customer, `refund-ui-${order}`],
    );
    await pool.query(
      "INSERT INTO payments (id,order_id,reference,amount,status,provider_created) VALUES ($1,$2,$3,105000,'SUCCEEDED',true)",
      [randomUUID(), order, `refund-ui-payment-${order}`],
    );
    await pool.query(
      "INSERT INTO deliveries (id,order_id,driver_id,status) VALUES ($1,$2,'driver','DELIVERED')",
      [randomUUID(), order],
    );
    await pool.query(
      "INSERT INTO reviews (id,order_id,customer_id,restaurant_id,rating,content) VALUES ($1,$2,$3,'pizza',2,'Pizza arrived cold and soggy.')",
      [randomUUID(), order, customer],
    );

    const customerPage = await (await browser.newContext()).newPage();
    await login(customerPage, `${customer}@test.local`);
    await customerPage.getByRole('link', { name: 'Orders', exact: true }).click();
    const card = customerPage.locator('.order-card').filter({ hasText: prefix });
    await expect(card.getByText('first send a support request')).toBeVisible();
    await card.getByRole('button', { name: 'Need help with this order?' }).click();
    await card.getByLabel('Describe the issue').fill('The pizza was cold and the box was crushed.');
    await card.getByRole('button', { name: 'Send to support' }).click();
    await card.getByText('Request a full refund').click();
    await card.getByLabel('Why should this order be refunded?').fill('Inedible food');
    await card.getByRole('button', { name: 'Send refund request' }).click();
    await expect(card.getByText('Refund requested · waiting for review')).toBeVisible();

    const adminPage = await (await browser.newContext()).newPage();
    await login(adminPage, 'admin@bep.local');
    await adminPage.getByRole('link', { name: 'Operations' }).click();
    const refunds = adminPage.getByRole('region', { name: 'Refund requests' });
    const item = refunds.locator('.queue-item').filter({ hasText: prefix });
    await item.getByLabel('Decision reason').fill('Photos confirm damage');
    await item.getByRole('button', { name: 'Approve full refund' }).click();
    await expect(item.getByText(/Refund approved · queued|Refund processing/)).toBeVisible();
    await adminPage.setViewportSize({ width: 375, height: 900 });
    expect(
      await adminPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();

    await customerPage.reload();
    await customerPage.getByRole('link', { name: 'Orders', exact: true }).click();
    await expect(
      customerPage
        .locator('.order-card')
        .filter({ hasText: prefix })
        .getByText(/Refund approved · queued|Refund processing|Refund confirmed/),
    ).toBeVisible();

    const kitchenPage = await (await browser.newContext()).newPage();
    await login(kitchenPage, 'restaurant2@bep.local');
    await kitchenPage.getByRole('link', { name: 'My kitchen' }).click();
    const reviews = kitchenPage.getByRole('region', { name: 'Customer reviews' });
    const restaurantSelect = reviews.getByLabel('Restaurant', { exact: true });
    if (await restaurantSelect.count()) await restaurantSelect.selectOption('pizza');
    const review = reviews.locator('.queue-item').filter({ hasText: 'Pizza arrived cold' });
    await review.getByLabel('Reply to this review').fill('Sorry! We have fixed our delivery bags.');
    await review.getByRole('button', { name: 'Post reply' }).click();
    await expect(review.getByLabel('Edit reply (revision 1)')).toHaveValue(
      'Sorry! We have fixed our delivery bags.',
    );
    const stored = await pool.query(
      'SELECT r.content, p.content AS reply FROM reviews r JOIN review_replies p ON p.review_id=r.id WHERE r.order_id=$1',
      [order],
    );
    expect(stored.rows).toEqual([
      {
        content: 'Pizza arrived cold and soggy.',
        reply: 'Sorry! We have fixed our delivery bags.',
      },
    ]);
  } finally {
    await pool.end();
  }
});
