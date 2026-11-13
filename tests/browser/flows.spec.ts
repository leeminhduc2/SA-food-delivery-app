import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
async function login(page: Page, role: string) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill(role + '@bep.local');
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
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
  await expect(page.locator('.restaurant-card')).toHaveCount(10);
  await page.screenshot({ path: 'test-results/discovery-desktop.png', fullPage: true });
  expect(
    (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze())
      .violations,
  ).toEqual([]);
  await page.getByRole('link', { name: 'Find your next favorite' }).click();
  await expect(page.locator('.restaurant-card')).toHaveCount(10);
  await page.getByLabel('Search restaurants or dishes').fill('Bếp Phố');
  await expect(page.locator('.restaurant-card')).toHaveCount(1);
  await page.getByLabel('Search restaurants or dishes').fill('missing-kitchen');
  await expect(page.getByText('No kitchens found')).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(page.locator('.restaurant-card')).toHaveCount(10);
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
test('catalog shows the seeded dataset, grouped menu, cuisine filter and safe image fallback', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await page.getByRole('link', { name: 'Find your next favorite' }).click();
  await expect(page.locator('.restaurant-card')).toHaveCount(10);
  await expect(page.locator('.demo-note')).toHaveCount(0);
  await expect(page.locator('.image-label').first()).not.toHaveText('Demo');
  const card = page.locator('.restaurant-card').filter({ hasText: 'Bếp Phố Hà Thành' });
  await expect(card).toContainText('Hoàn Kiếm');
  await card.click();
  await expect(page.getByRole('heading', { name: 'Bếp Phố Hà Thành' })).toBeVisible();
  await expect(page.locator('.demo-note')).toHaveCount(0);
  await expect(page.locator('.source-line')).toHaveCount(0);
  await expect(page.locator('.meta')).toContainText('4.8 / 5 (512)');
  await expect(page.locator('.subtle')).toContainText('Hoàn Kiếm');
  await expect(page.locator('.menu-section')).toHaveCount(2);
  await expect(page.locator('.dish')).toHaveCount(6);
  await expect(page.locator('.menu-category')).toHaveText(['Món chính', 'Món khai vị']);
  await expect(page.locator('.restaurant-hero img')).toHaveCount(1);
  await expect(page.locator('.restaurant-hero .image-placeholder')).toHaveCount(0);
  // 59 of the 60 raster assets exist; mock-item-001.webp is intentionally
  // missing, so its dish card must show the honest placeholder.
  await expect(page.locator('.dish img')).toHaveCount(5);
  await expect(page.locator('.dish .image-placeholder')).toHaveCount(1);
  await page.getByRole('button', { name: 'All restaurants' }).click();
  await page.getByRole('button', { name: 'Japanese', exact: true }).click();
  await expect(page.locator('.restaurant-card')).toHaveCount(1);
  await expect(page.locator('.restaurant-card')).toContainText('Sushi Mori');
  await page.getByRole('button', { name: 'All kitchens', exact: true }).click();
  await expect(page.locator('.restaurant-card')).toHaveCount(10);
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
  }
  expect(errors).toEqual([]);
});
test('customer checkout through restaurant preparation, assignment, driver delivery, review and complaint', async ({
  browser,
}) => {
  const customer = await browser.newContext();
  const page = await customer.newPage();
  await login(page, 'customer');
  // Checkout requires a saved, geocoded address; save one before ordering.
  await page.getByRole('button', { name: 'Account settings' }).click();
  const account = page.getByRole('dialog');
  await account.getByLabel('Street address').fill('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội');
  await account.getByRole('button', { name: 'Find address' }).click();
  await expect(account.locator('.resolved-address')).toContainText('Hà Nội');
  await account.getByRole('button', { name: 'Save delivery address' }).click();
  await expect(account.locator('.current-address')).toContainText('18 Phố Hàng Bạc');
  await account.getByRole('button', { name: 'Close dialog' }).click();
  await page.locator('.restaurant-card').filter({ hasText: 'Bếp Phố Hà Thành' }).click();
  await expect(page.getByRole('heading', { name: 'The menu' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Phở bò đặc biệt', exact: true }).click();
  await page.getByRole('button', { name: /Basket/ }).click();
  await expect(page.getByRole('dialog')).toContainText('85.000');
  await page.getByRole('button', { name: 'Continue to checkout' }).click();
  await expect(page.getByRole('dialog')).toContainText('Deliver to your saved address');
  await expect(page.getByLabel('Delivery address')).toHaveCount(0);
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
  const driver = await browser.newContext();
  await driver.addInitScript(() => {
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
  const driverPage = await driver.newPage();
  await login(driverPage, 'driver');
  await driverPage.getByRole('link', { name: 'My deliveries' }).click();
  const availability = driverPage
    .locator('section')
    .filter({ has: driverPage.getByRole('heading', { name: 'Driver availability' }) });
  await availability.getByRole('button', { name: 'Enable location' }).click();
  await expect(availability).toContainText('Location is recent');
  await availability.getByRole('button', { name: 'Go online' }).click();
  await availability.getByRole('button', { name: 'Set ready', exact: true }).click();
  await expect(availability).toContainText('Online · Ready');
  const admin = await browser.newContext();
  const adminPage = await admin.newPage();
  await login(adminPage, 'admin');
  await adminPage.getByRole('link', { name: 'Orders', exact: true }).click();
  await adminPage.getByLabel('Assign a driver for an exception').selectOption('driver');
  await adminPage.getByLabel('Reason', { exact: true }).fill('Operational recovery');
  await adminPage.getByRole('button', { name: 'Assign for exception', exact: true }).click();
  await expect(adminPage.getByText('Your driver: Đức Lê')).toBeVisible();
  await driverPage.reload();
  await driverPage.getByRole('link', { name: 'My deliveries' }).click();
  await expect(
    driverPage.getByText(
      'Finish your active delivery before going offline. You can still set yourself not ready.',
    ),
  ).toBeVisible();
  for (const state of ['Picked up', 'In transit', 'Delivered'])
    await driverPage.getByRole('button', { name: state, exact: true }).click();
  await expect(driverPage.locator('.order-card > .between .status')).toHaveText('Delivered');
  await driverPage.reload();
  await driverPage.getByRole('link', { name: 'My deliveries' }).click();
  await availability.getByRole('button', { name: 'Go offline' }).click();
  await expect(availability).toContainText('Offline');
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
  const kitchen = page.locator('.manage-row').filter({ hasText: 'Bếp Phố Hà Thành' });
  await kitchen.getByRole('button', { name: 'Manage menu', exact: true }).click();
  const dish = page.getByRole('dialog').locator('.manage-item').filter({ hasText: 'Nem rán' });
  await dish.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Price (VND)').fill('39000');
  await page.getByLabel('Available servings').fill('25');
  await page.getByRole('button', { name: 'Save dish', exact: true }).click();
  await expect(
    page.getByRole('dialog').locator('.manage-item').filter({ hasText: 'Nem rán' }),
  ).toContainText('39.000');
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.reload();
  await page
    .locator('.manage-row')
    .filter({ hasText: 'Bếp Phố Hà Thành' })
    .getByRole('button', { name: 'Manage menu', exact: true })
    .click();
  await expect(
    page.getByRole('dialog').locator('.manage-item').filter({ hasText: 'Nem rán' }),
  ).toContainText('39.000');
});

test('saved delivery address drives walking distance, fee and address changes', async ({
  page,
}) => {
  await login(page, 'customer');
  await page.getByRole('button', { name: 'Account settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Street address').fill('18 Phố Hàng Bạc, Hoàn Kiếm, Hà Nội');
  await dialog.getByRole('button', { name: 'Find address' }).click();
  await expect(dialog.locator('.resolved-address')).toContainText('Hà Nội');
  await dialog.getByRole('button', { name: 'Save delivery address' }).click();
  await expect(dialog.locator('.current-address')).toContainText('18 Phố Hàng Bạc');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('link', { name: 'Find your next favorite' }).click();
  const card = page.locator('.restaurant-card').filter({ hasText: 'Bếp Phố Hà Thành' });
  await expect(card).toContainText('1.2 km');
  await expect(card).toContainText('10.000');
  await card.click();
  await expect(page.locator('.delivery-overview')).toContainText('1.2 km');
  await expect(page.locator('.delivery-overview')).toContainText('10.000');

  await page.getByRole('button', { name: 'Account settings' }).click();
  await dialog.getByLabel('Street address').fill('50 Phố Huế, Hai Bà Trưng, Hà Nội');
  await dialog.getByRole('button', { name: 'Find address' }).click();
  await expect(dialog.locator('.resolved-address')).toContainText('Hà Nội');
  await dialog.getByRole('button', { name: 'Save delivery address' }).click();
  await expect(dialog.locator('.current-address')).toContainText('50 Phố Huế');
  await dialog.getByRole('button', { name: 'Close dialog' }).click();

  await page.getByRole('link', { name: 'Bếp home' }).click();
  await expect(
    page.locator('.restaurant-card').filter({ hasText: 'Bếp Phố Hà Thành' }),
  ).toContainText('5.0 km');
  await expect(
    page.locator('.restaurant-card').filter({ hasText: 'Bếp Phố Hà Thành' }),
  ).toContainText('19.000');
});

test('admin workspace keeps catalog editing with restaurant owners and requires a reason', async ({
  page,
}) => {
  await login(page, 'admin');
  await page.getByRole('link', { name: 'Operations' }).click();
  const restaurant = page.locator('.manage-row').first();
  await expect(restaurant).toBeVisible();
  await expect(restaurant.getByRole('button', { name: 'Manage menu' })).toHaveCount(0);
  await expect(restaurant.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
  await expect(restaurant.getByRole('button', { name: 'Suspend' })).toBeDisabled();
  await restaurant.getByLabel(/Reason to reject or suspend/).fill('Policy review');
  await expect(restaurant.getByRole('button', { name: 'Suspend' })).toBeEnabled();
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  }
});

test('driver denied GPS remains offline and offers an accessible retry', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (_ok: unknown, fail: (error: { code: number }) => void) => {
          setTimeout(() => fail({ code: 1 }), 0);
          return 7;
        },
        clearWatch: () => {},
      },
    });
  });
  await login(page, 'driver2');
  await page.getByRole('link', { name: 'My deliveries' }).click();
  const panel = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Driver availability' }) });
  await expect(panel).toContainText('Offline');
  await panel.getByRole('button', { name: 'Enable location' }).click();
  await expect(panel.getByRole('alert')).toContainText('permission denied');
  await expect(panel.getByRole('button', { name: 'Go online' })).toBeDisabled();
  await expect(panel.getByRole('button', { name: 'Enable location' })).toBeEnabled();
});

test('driver GPS enables online and is cleaned up on logout', async ({ page }) => {
  const keyWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('same key')) keyWarnings.push(message.text());
  });
  await page.addInitScript(() => {
    const mock = window as any;
    mock.geoCleared = 0;
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        watchPosition: (ok: (position: unknown) => void) => {
          mock.geoCallback = ok;
          setTimeout(
            () => ok({ coords: { latitude: 21.03, longitude: 105.85 }, timestamp: Date.now() }),
            0,
          );
          return 7;
        },
        clearWatch: () => {
          mock.geoCleared++;
        },
      },
    });
  });
  let locations = 0;
  page.on('request', (req) => {
    if (req.url().endsWith('/api/driver/location') && req.method() === 'POST') locations++;
  });
  await login(page, 'driver');
  await page.getByRole('link', { name: 'My deliveries' }).click();
  const panel = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: 'Driver availability' }) });
  await panel.getByRole('button', { name: 'Enable location' }).click();
  await expect(panel).toContainText('Location is recent');
  await panel.getByRole('button', { name: 'Go online' }).click();
  await expect(panel).toContainText('Online');
  for (const width of [375, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  }
  await page.getByRole('button', { name: 'Account settings' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Sign out' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).geoCleared)).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { name: 'Driver availability' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Delivery offers' })).toHaveCount(0);
  const before = locations;
  await page.evaluate(() =>
    (window as any).geoCallback({
      coords: { latitude: 21, longitude: 105 },
      timestamp: Date.now() + 11000,
    }),
  );
  await page.waitForTimeout(250);
  expect(locations).toBe(before);
  expect(keyWarnings).toEqual([]);
});
