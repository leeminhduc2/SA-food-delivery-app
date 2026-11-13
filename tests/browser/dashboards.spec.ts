import { expect, test, type Page } from '@playwright/test';

async function login(page: Page, who: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill(`${who}@bep.local`);
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function noOverflow(page: Page) {
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
}

test('role dashboards label estimates and gross values and show no fake numbers', async ({
  browser,
}) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'admin');
  await admin.getByRole('link', { name: 'Operations' }).click();
  const kpis = admin.getByRole('region', { name: 'Platform KPIs' });
  await expect(kpis.getByText('Drivers online')).toBeVisible();
  await expect(kpis.getByText('Gross delivered value')).toBeVisible();
  await expect(kpis.getByText('Items plus delivery fees; not a payout')).toBeVisible();
  // A day with no terminal trips shows "No data", not 0%.
  await kpis.getByLabel('From (Asia/Saigon)').fill('2020-01-01');
  await kpis.getByLabel('To (inclusive)').fill('2020-01-01');
  await expect(
    kpis.locator('.stat, .stats > div').filter({ hasText: 'Success rate' }),
  ).toContainText('No data');
  await expect(kpis.getByText('No orders in this period.')).toBeVisible();
  await noOverflow(admin);

  const kitchen = await (await browser.newContext()).newPage();
  await login(kitchen, 'restaurant');
  await kitchen.getByRole('link', { name: 'My kitchen' }).click();
  const performance = kitchen.getByRole('region', { name: 'Performance' });
  await expect(performance.getByText('Items plus delivery fee; not your payout')).toBeVisible();
  await expect(performance.getByRole('heading', { name: 'Low stock' })).toBeVisible();
  await noOverflow(kitchen);

  const driver = await (await browser.newContext()).newPage();
  await login(driver, 'driver');
  await driver.getByRole('link', { name: 'My deliveries' }).click();
  const earnings = driver.getByRole('region', { name: 'Performance and estimated earnings' });
  await expect(earnings.getByText('Estimated earnings (not a payout)')).toBeVisible();
  await expect(earnings.getByText(/Not a payout/)).toBeVisible();
  await noOverflow(driver);
});
