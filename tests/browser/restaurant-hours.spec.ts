import { expect, test } from '@playwright/test';

test('restaurant owner can edit phone and structured hours without mobile overflow', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const login = page.getByRole('dialog');
  await login.getByLabel('Email', { exact: true }).fill('restaurant@bep.local');
  await login.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await login.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(login).not.toBeVisible();
  const kitchen = page.locator('.manage-row').filter({ hasText: 'Bếp Phố Hà Thành' });
  await kitchen.getByRole('button', { name: 'Edit details' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Phone', { exact: true }).fill('0901234567');
  await dialog.getByLabel('Use an opening schedule').check();
  await dialog.getByRole('button', { name: 'Add Monday interval' }).click();
  await dialog.getByLabel('Monday interval 1 start').fill('09:00');
  await dialog.getByLabel('Monday interval 1 end').fill('24:00');
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await dialog.getByRole('button', { name: 'Save kitchen' }).click();
  await expect(dialog).not.toBeVisible();
  await page.reload();
  await kitchen.getByRole('button', { name: 'Edit details' }).click();
  await expect(dialog.getByLabel('Phone', { exact: true })).toHaveValue('0901234567');
  await expect(dialog.getByLabel('Monday interval 1 end')).toHaveValue('24:00');
  await dialog.getByLabel('Use an opening schedule').uncheck();
  await dialog.getByLabel('Phone', { exact: true }).clear();
  await dialog.getByRole('button', { name: 'Save kitchen' }).click();
  await expect(dialog).not.toBeVisible();
});
