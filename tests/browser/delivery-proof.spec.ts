import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

test('driver proof form reports errors accessibly and a photo unlocks completion', async ({
  page,
}) => {
  const schema = process.env.E2E_SCHEMA;
  if (!schema || !/^e2e_[a-f0-9]{32}$/.test(schema) || !process.env.TEST_DATABASE_URL)
    throw new Error('An isolated E2E schema is required');
  const url = new URL(process.env.TEST_DATABASE_URL);
  url.searchParams.set('schema', schema);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 3000 });
  const order = randomUUID(),
    delivery = randomUUID(),
    driver = `proof-ui-${randomUUID()}`,
    customer = `proof-customer-${randomUUID()}`;
  const logged: string[] = [];
  page.on('console', (message) => logged.push(message.text()));
  try {
    expect((await pool.query('SELECT current_schema() AS schema')).rows[0].schema).toBe(schema);
    await pool.query(
      "INSERT INTO users (id,email,name,password_hash,role,active) SELECT $1,$2,'Proof driver',password_hash,'DRIVER',true FROM users WHERE id='driver'",
      [driver, `${driver}@test.local`],
    );
    await pool.query(
      "INSERT INTO users (id,email,name,password_hash,role,active) SELECT $1,$2,'Proof customer',password_hash,'CUSTOMER',true FROM users WHERE id='customer'",
      [customer, `${customer}@test.local`],
    );
    await pool.query(
      "INSERT INTO orders (id,customer_id,restaurant_id,status,subtotal,delivery_fee,total,address,idempotency_key,fingerprint,expires_at) VALUES ($1,$3,'pizza','OUT_FOR_DELIVERY',1000,0,1000,'Test address',$2,'test',now()+interval '10 minutes')",
      [order, `proof-ui-${order}`, customer],
    );
    await pool.query(
      "INSERT INTO payments (id,order_id,reference,amount,status) VALUES ($1,$2,$3,1000,'SUCCEEDED')",
      [randomUUID(), order, `proof-ui-payment-${order}`],
    );
    await pool.query(
      "INSERT INTO deliveries (id,order_id,driver_id,status,proof_required) VALUES ($1,$2,$3,'IN_TRANSIT',true)",
      [delivery, order, driver],
    );
    await pool.query(
      'INSERT INTO driver_assignments (id,delivery_id,driver_id,active) VALUES ($1,$2,$3,true)',
      [randomUUID(), delivery, driver],
    );
    await pool.query(
      "INSERT INTO delivery_otp_challenges (id,order_id,delivery_id,assignment_id,customer_id,salt,otp_hash,expires_at,key_hash) SELECT $1,$2,$3,id,$4,'00','00',now()+interval '10 minutes','ui' FROM driver_assignments WHERE delivery_id=$3",
      [randomUUID(), order, delivery, customer],
    );
    await page.goto('/');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Email', { exact: true }).fill(`${driver}@test.local`);
    await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await page.getByRole('link', { name: 'My deliveries' }).click();
    const card = page.locator('.order-card').filter({ hasText: order.slice(0, 8).toUpperCase() });
    const proof = card.getByLabel('Delivery proof');
    await expect(
      card.getByRole('button', { name: 'Add delivery proof to complete' }),
    ).toBeDisabled();
    await proof.getByLabel('Customer delivery code').fill('123456');
    await proof.getByRole('button', { name: 'Verify code' }).click();
    const alert = proof.getByRole('alert');
    await expect(alert).toContainText('Invalid delivery code');
    await expect(alert).toBeFocused();
    await proof
      .getByLabel(/Delivery photo/)
      .setInputFiles({ name: 'note.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await proof.getByRole('button', { name: 'Upload photo' }).click();
    await expect(alert).toContainText('Only JPEG or PNG');
    for (const width of [375, 768, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      ).toBeTruthy();
    }
    await proof.getByLabel(/Delivery photo/).setInputFiles({
      name: 'door.jpg',
      mimeType: 'image/jpeg',
      buffer: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)]),
    });
    await proof.getByRole('button', { name: 'Upload photo' }).click();
    await expect(card.getByText('Delivery proof verified: photo')).toBeVisible();
    await card.getByRole('button', { name: 'Delivered', exact: true }).click();
    await expect(card.locator('.between .status')).toHaveText('Delivered');
    expect(logged.join('\n')).not.toContain('123456');
    const proofs = await pool.query(
      'SELECT method,status FROM delivery_proofs WHERE delivery_id=$1',
      [delivery],
    );
    expect(proofs.rows).toEqual([{ method: 'PHOTO', status: 'VERIFIED' }]);
  } finally {
    await pool.end();
  }
});
