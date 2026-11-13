import { expect, test } from '@playwright/test';

test('restaurant owner creates, renames and deletes an empty menu group', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email', { exact: true }).fill('restaurant@bep.local');
  await dialog.getByLabel('Password', { exact: true }).fill('BrowserTest123!');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page
    .locator('.manage-row')
    .filter({ hasText: 'Bếp Phố Hà Thành' })
    .getByRole('button', { name: 'Manage menu' })
    .click();
  const groups = dialog.getByLabel('Menu groups');
  await groups.getByLabel('New group name').fill('Seasonal');
  await groups.getByRole('button', { name: 'Add group' }).click();
  const group = groups
    .locator('form')
    .filter({ has: page.getByRole('textbox', { name: 'Group name Seasonal', exact: true }) });
  await expect(group).toContainText('0 dishes');
  await group.getByLabel('Group name Seasonal').fill('Seasonal dishes');
  await group.getByRole('button', { name: 'Rename' }).click();
  await expect(groups.getByLabel('Group name Seasonal dishes')).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await groups.getByRole('button', { name: 'Delete Seasonal dishes' }).click();
  await expect(groups.getByLabel('Group name Seasonal dishes')).toHaveCount(0);
});
