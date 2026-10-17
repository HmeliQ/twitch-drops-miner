import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

test.beforeEach(async ({ request }) => {
  expect(
    (await request.post('/__test/reset', { headers: { 'X-TDM-Request': '1' }, data: {} })).ok(),
  ).toBe(true);
});

test('Settings uses consistent section spacing and keeps access help behind its info button', async ({
  page,
}) => {
  for (const viewport of [
    { width: 375, height: 667 },
    { width: 320, height: 568 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    for (const section of ['account', 'notifications', 'connection', 'access', 'maintenance']) {
      await page.goto(`/settings#${section}`);
      const content = page.locator(`#settings-${section}`);
      await expect(content).toBeVisible();
      const above =
        viewport.width < 1024
          ? page.getByRole('heading', { level: 1 }).locator('..')
          : page.getByRole('navigation', { name: 'Settings sections' });
      const heading = (await above.boundingBox())!;
      const body = (await content.boundingBox())!;
      expect(body.y - heading.y - heading.height).toBe(viewport.width < 1024 ? 24 : 32);
      expect(body.x).toBe(heading.x);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(viewport.width);
      if (section === 'notifications') {
        await expect(content.getByLabel('Bot token', { exact: true })).toBeEnabled();
        const boxes = content.locator('label:has(input[type="checkbox"])');
        const first = (await boxes.nth(0).boundingBox())!;
        const second = (await boxes.nth(1).boundingBox())!;
        expect(second.y - first.y - first.height).toBe(4);
        expect(first.height).toBeGreaterThanOrEqual(viewport.width < 768 ? 44 : 36);
        const save = content.getByRole('button', { name: 'Save', exact: true });
        await save.evaluate((element) => element.scrollIntoView({ block: 'center' }));
        const saveBox = (await save.boundingBox())!;
        const navigation = (await page
          .getByRole('navigation', { name: 'Main navigation' })
          .boundingBox())!;
        if (viewport.width < 1024)
          expect(saveBox.y + saveBox.height).toBeLessThanOrEqual(navigation.y);
        await page.evaluate(() =>
          (innerWidth < 1024 ? document.getElementById('main')! : window).scrollTo(0, 0),
        );
      }
      if (section === 'access') {
        const help = content.getByRole('button', { name: 'Dashboard access help', exact: true });
        const note = content.getByRole('note', {
          name: 'Dashboard access help',
          exact: true,
          includeHidden: true,
        });
        const password = content.getByLabel('New password (at least 8 characters)', {
          exact: true,
        });
        await expect(note).toBeHidden();
        const before = (await password.boundingBox())!;
        await help.focus();
        await help.press('Enter');
        await expect(note).toBeVisible();
        await expect(note).toContainText('Changing it signs out other sessions.');
        expect((await password.boundingBox())!.y).toBe(before.y);
        const bounds = (await note.boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height);
        expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
        await page.screenshot({ path: `../artifacts/settings-access-help-${viewport.width}.png` });
        await page.keyboard.press('Escape');
        await expect(note).toBeHidden();
        await expect(help).toBeFocused();
        await help.click();
        await page.getByRole('heading', { level: 1 }).click();
        await expect(note).toBeHidden();
      }
      if (section === 'connection') {
        const help = content.getByRole('button', { name: 'Proxy URL help', exact: true });
        const note = content.getByRole('note', {
          name: 'Proxy URL help',
          exact: true,
          includeHidden: true,
        });
        await expect(note).toBeHidden();
        await help.click();
        await expect(note).toContainText('Dashboard HTTPS is configured separately.');
        await page.keyboard.press('Escape');
        await expect(note).toBeHidden();
        await expect(help).toBeFocused();
      }
      await page.screenshot({
        path: `../artifacts/settings-spacing-${section}-${viewport.width}.png`,
        fullPage: true,
      });
    }
  }
});

for (const width of [390, 320]) {
  test(`mobile Settings menu preserves drafts, deep links and return navigation at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto('/settings');
    const menu = page.getByRole('navigation', { name: 'Settings sections' });
    await expect(menu.getByRole('link')).toHaveText([
      'Mining preferences',
      'Accounts',
      'Notifications',
      'Connection',
      'Dashboard access',
      'Maintenance',
    ]);
    await expect(page.locator('#settings-account')).toBeHidden();
    await expect(menu.locator('[aria-current]')).toHaveCount(0);
    for (const link of await menu.getByRole('link').all()) {
      const box = (await link.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBe(width - 32);
    }
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `../artifacts/settings-menu-${width}.png`, fullPage: true });

    const access = menu.getByRole('link', { name: 'Dashboard access', exact: true });
    await access.focus();
    await access.press('Enter');
    await expect(menu).toBeHidden();
    await expect(
      page.getByRole('heading', { name: 'Dashboard access', exact: true }),
    ).toBeFocused();
    const password = page.getByLabel('New password (at least 8 characters)', { exact: true });
    await password.fill('unsaved-test-draft');
    await page.getByRole('link', { name: 'Back to Settings' }).click();
    await expect(access).toBeFocused();
    await access.click();
    await expect(password).toHaveValue('unsaved-test-draft');
    await page.goBack();
    await expect(access).toBeFocused();
    await page.goForward();
    await expect(password).toHaveValue('unsaved-test-draft');

    await page.getByRole('link', { name: 'Back to Settings' }).click();
    const mining = menu.getByRole('link', { name: 'Mining preferences', exact: true });
    await mining.click();
    await expect(page).toHaveURL(/\/\?edit=priorities$/);
    await expect(page.getByRole('heading', { name: 'Mining preferences' })).toBeFocused();
    await page.reload();
    await page.getByRole('link', { name: 'Back to Settings' }).click();
    await expect(mining).toBeFocused();
    await mining.click();
    await page.goBack();
    await expect(mining).toBeFocused();

    await page.goto('/settings#connection');
    const connectionHeading = page.getByRole('heading', { name: 'Connection', exact: true });
    await expect(connectionHeading).toBeVisible();
    await expect(menu).toBeHidden();
    expect(
      await page.evaluate(() => window.scrollY + (document.getElementById('main')?.scrollTop ?? 0)),
    ).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `../artifacts/settings-section-${width}.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(menu.getByRole('link', { name: 'Connection', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await page.setViewportSize({ width, height: 844 });
    await expect(connectionHeading).toBeVisible();
    await page.getByRole('link', { name: 'Back to Settings' }).click();
    await expect(menu.getByRole('link', { name: 'Connection', exact: true })).toBeFocused();
  });
}

test('desktop Settings keeps tabs and the mining editor returns to its entry point', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings');
  const tabs = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(page.locator('#settings-account')).toBeVisible();
  await expect(page).toHaveURL(/\/settings#account$/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#settings-account')).toBeVisible();
  await expect(tabs).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(tabs).toBeVisible();
  const boxes = await tabs
    .getByRole('link')
    .evaluateAll((links) => links.map((link) => link.getBoundingClientRect().y));
  expect(new Set(boxes).size).toBe(1);
  await page.screenshot({ path: '../artifacts/settings-tabs-1440.png', fullPage: true });
  const mining = tabs.getByRole('link', { name: 'Mining preferences' });
  await mining.click();
  await page.getByRole('link', { name: 'Back to Settings' }).click();
  await expect(mining).toBeFocused();
  await mining.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Accounts', exact: true })).toBeFocused();
  await expect(tabs).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await tabs.getByRole('link', { name: 'Connection', exact: true }).click();
  await mining.click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Connection', exact: true })).toBeFocused();
  await expect(tabs).toBeHidden();
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Back to Settings' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to Mining' }).click();
  await expect(page.getByRole('link', { name: 'Edit', exact: true })).toBeFocused();
  await page.goto('/settings#mining');
  await page.getByRole('link', { name: 'Back to Settings' }).click();
  await expect(mining).toBeFocused();
});
