import AxeBuilder from '@axe-core/playwright';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
async function login(page: Page, role: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill(role + '@bep.local');
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
}
async function request(context: BrowserContext, path: string, body?: unknown) {
  const result = await context.request.post('/api' + path, {
    data: body,
    headers: { 'X-Requested-With': 'Bep' },
  });
  expect(result.ok(), await result.text()).toBeTruthy();
  return result.json();
}
test('responsive discovery, search, empty state, keyboard dialog and navigation', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'A little hungry? You’re in the right place.' }),
  ).toBeVisible();
  await expect(page.locator('.restaurant-card')).toHaveCount(3);
  await page.screenshot({ path: 'test-results/discovery-desktop.png', fullPage: true });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('link', { name: 'Find your next favorite' }).click();
  await expect(page.locator('.restaurant-card')).toHaveCount(3);
  await page.getByLabel('Search restaurants or dishes').fill('phở');
  await expect(page.locator('.restaurant-card')).toHaveCount(1);
  await page.getByLabel('Search restaurants or dishes').fill('missing-kitchen');
  await expect(page.getByText('No kitchens found')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('.restaurant-card')).toHaveCount(3);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.screenshot({ path: 'test-results/discovery-mobile.png', fullPage: true });
  expect(errors).toEqual([]);
});
test('customer checkout through restaurant preparation, assignment, driver delivery, review and complaint', async ({
  browser,
}) => {
  const customer = await browser.newContext();
  const page = await customer.newPage();
  await login(page, 'customer');
  await page.locator('.restaurant-card').filter({ hasText: 'Bếp Nhà Sài Gòn' }).click();
  await expect(page.getByRole('heading', { name: 'The menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Phở bò đặc biệt', exact: true }).click();
  await page.getByRole('button', { name: /Basket/ }).click();
  await expect(page.getByRole('dialog')).toContainText('80.000');
  await page.getByRole('button', { name: 'Continue to checkout' }).click();
  await page.getByLabel('Delivery address').fill('12 Nguyễn Huệ, District 1');
  await page.getByRole('button', { name: 'Place order', exact: true }).click();
  await expect(page.locator('.order-card')).toHaveCount(1);
  await page.getByRole('button', { name: 'Simulate successful payment' }).click();
  await expect(page.locator('.order-card > .between .status')).toHaveText('Confirmed');
  await page.screenshot({ path: 'test-results/customer-order.png', fullPage: true });
  const orders = await (await customer.request.get('/api/orders')).json();
  const order = orders[0];
  const kitchen = await browser.newContext();
  const kitchenPage = await kitchen.newPage();
  await login(kitchenPage, 'restaurant');
  await kitchenPage.getByRole('link', { name: 'Orders', exact: true }).click();
  for (const state of ['Accepted', 'Preparing', 'Ready for pickup']) {
    await kitchenPage.getByRole('button', { name: state, exact: true }).click();
    await expect(kitchenPage.locator('.order-card > .between .status')).toHaveText(state);
  }
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await login(adminPage, 'admin');
  await adminPage.getByRole('link', { name: 'Orders', exact: true }).click();
  await adminPage.getByLabel('Assign a driver').selectOption('driver');
  await adminPage.getByRole('button', { name: 'Assign', exact: true }).click();
  await expect(adminPage.getByText('Your driver: Đức Lê')).toBeVisible();
  const driver = await browser.newContext();
  const driverPage = await driver.newPage();
  await login(driverPage, 'driver');
  for (const state of ['Picked up', 'In transit', 'Delivered'])
    await driverPage.getByRole('button', { name: state, exact: true }).click();
  await expect(driverPage.locator('.order-card > .between .status')).toHaveText('Delivered');
  await page.reload();
  await expect(page.locator('.order-card > .between .status')).toHaveText('Delivered');
  await page.getByText('How was your meal? Leave a review').click();
  await page.getByLabel('Your review', { exact: true }).fill('Warm food and a friendly delivery.');
  await page.getByRole('button', { name: 'Share review' }).click();
  await expect(page.getByText(/Your review: 5\/5/)).toBeVisible();
  await page.getByRole('button', { name: 'Need help with this order?' }).click();
  await page.getByLabel('Describe the issue').fill('Please provide a receipt for this order.');
  await page.getByRole('button', { name: 'Send to support' }).click();
  await expect(page.getByRole('status')).toContainText('Changes saved');
  await adminPage.getByRole('link', { name: 'Operations', exact: true }).click();
  await adminPage.reload();
  await adminPage
    .getByLabel('Resolution', { exact: true })
    .fill('Receipt is available in your order details.');
  await adminPage.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(adminPage.locator('.support-request .status')).toHaveText('Resolved');
  await adminPage.screenshot({ path: 'test-results/admin-workspace.png', fullPage: true });
  expect(order.payment.status).toBe('SUCCEEDED');
  await Promise.all([customer.close(), kitchen.close(), admin.close(), driver.close()]);
});
test('restaurant edits menu options and stock with persistent results', async ({ page }) => {
  await login(page, 'restaurant');
  await page.getByRole('button', { name: 'Manage menu', exact: true }).click();
  const dish = page.getByRole('dialog').locator('.manage-item').filter({ hasText: 'Gỏi cuốn tôm' });
  await dish.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Price (VND)').fill('49000');
  await page.getByLabel('Available servings').fill('25');
  await page.getByRole('button', { name: 'Save dish', exact: true }).click();
  await expect(
    page.getByRole('dialog').locator('.manage-item').filter({ hasText: 'Gỏi cuốn tôm' }),
  ).toContainText('49.000');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await page.getByRole('button', { name: 'Manage menu', exact: true }).click();
  await expect(
    page.getByRole('dialog').locator('.manage-item').filter({ hasText: 'Gỏi cuốn tôm' }),
  ).toContainText('25 available');
});
