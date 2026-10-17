import { test, expect, type Locator } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fixture from './fixture.json' with { type: 'json' };

const headers = { 'X-TDM-Request': '1' };
test.beforeEach(async ({ request }) => {
  expect((await request.post('/__test/reset', { headers, data: {} })).ok()).toBe(true);
});

test('app metadata is available with optional login and on the locked dashboard', async ({
  page,
  request,
}) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Mining', exact: true })).toBeVisible();
  await request.post('/api/auth/settings', {
    headers,
    data: {
      action: 'enable',
      password: 'test password',
      confirm_password: 'test password',
    },
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Unlock dashboard', exact: true })).toBeVisible();
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    'href',
    '/manifest.webmanifest',
  );
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({
    id: '/',
    scope: '/',
    start_url: '/',
    name: 'Drops Miner',
    display: 'standalone',
  });
  const icons = [
    ...manifest.icons.map((icon: { src: string }) => icon.src),
    '/pwa/apple-touch-icon.png',
  ];
  for (const icon of icons) expect((await page.request.get(icon)).ok()).toBe(true);
  expect(
    await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length),
  ).toBe(0);
  expect((await page.request.get('/api/accounts')).status()).toBe(401);
});

for (const size of [
  { width: 390, height: 844 },
  { width: 844, height: 390 },
  { width: 320, height: 568 },
]) {
  test(`safe areas keep navigation, popovers and dialogs reachable at ${size.width}px`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    await page.goto('/campaigns');
    const safe =
      size.width > 767
        ? { top: 0, left: 44, right: 44, bottom: 21 }
        : { top: 47, left: 0, right: 0, bottom: 34 };
    await page.evaluate((safe) => {
      for (const [side, value] of Object.entries(safe))
        document.documentElement.style.setProperty(`--safe-${side}`, `${value}px`);
    }, safe);
    const fits = async (element: Locator, vertical = true) => {
      await expect(element).toBeVisible();
      const box = (await element.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(safe.left);
      expect(box.x + box.width).toBeLessThanOrEqual(size.width - safe.right + 1);
      if (vertical) {
        expect(box.y).toBeGreaterThanOrEqual(safe.top);
        expect(box.y + box.height).toBeLessThanOrEqual(size.height - safe.bottom + 1);
      }
    };
    for (const link of await page.locator('.primary-nav a').all()) await fits(link);
    await page.getByRole('button', { name: /^Games/ }).click();
    await fits(page.getByRole('group', { name: 'Games', exact: true }));
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Campaign details', exact: true }).first().click();
    await fits(page.locator('.campaign-detail'));
    await page.screenshot({ path: `../artifacts/pwa-details-${size.width}.png` });
    await page.goto('/settings#account');
    await page.evaluate((safe) => {
      for (const [side, value] of Object.entries(safe))
        document.documentElement.style.setProperty(`--safe-${side}`, `${value}px`);
    }, safe);
    await page.getByRole('button', { name: 'Rename Twitch 123456', exact: true }).click();
    await fits(page.getByRole('dialog'));
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }),
    ).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  });
}

test('foreground restoration refreshes both sockets without losing the account, page or draft', async ({
  page,
  request,
}) => {
  const second = '00000000000000000000000000000001';
  await request.post('/__test/accounts', {
    headers,
    data: [{ ...fixture, login: { status: 'Logged in', user_id: 200 } }],
  });
  const upgrades = new Set<string>();
  const snapshots: string[] = [];
  let hold = false;
  const pending: (() => void)[] = [];
  await page.route('**/socket.io/**', async (route) => {
    const response = await route.fetch();
    const body = await response.text();
    const account = new URL(route.request().url()).searchParams.get('account')!;
    if (body.includes('42["state_snapshot"') || body.includes('42["accounts"')) {
      snapshots.push(account);
      if (hold) {
        await new Promise<void>((resolve) =>
          pending.push(() => {
            resolve();
          }),
        );
      }
    }
    await route.fulfill({ response, body });
  });
  await page.routeWebSocket('**/socket.io/**', (socket) => {
    const account = new URL(socket.url()).searchParams.get('account')!;
    const server = socket.connectToServer();
    socket.onMessage((message) => {
      if (message === '5') upgrades.add(account);
      server.send(message);
    });
    server.onMessage((message) => {
      if (
        message.toString().startsWith('42["state_snapshot"') ||
        message.toString().startsWith('42["accounts"')
      ) {
        snapshots.push(account);
        if (hold) {
          pending.push(() => socket.send(message));
          return;
        }
      }
      socket.send(message);
    });
  });
  await page.goto(`/settings?account=${second}#access`);
  await expect.poll(() => upgrades.has('overview') && upgrades.has(second)).toBe(true);
  const draft = page.getByLabel('New password (at least 8 characters)', { exact: true });
  await draft.fill('unsaved-password');
  await page.getByLabel('Confirm new password', { exact: true }).fill('unsaved-password');
  await expect(
    page.getByRole('button', { name: 'Enable password protection', exact: true }),
  ).toBeEnabled();
  hold = true;
  snapshots.length = 0;
  await page.evaluate(() =>
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })),
  );
  await expect.poll(() => snapshots.includes('overview') && snapshots.includes(second)).toBe(true);
  await expect(
    page.getByRole('button', { name: 'Enable password protection', exact: true }),
  ).toBeDisabled();
  hold = false;
  pending.splice(0).forEach((send) => send());
  await expect(draft).toHaveValue('unsaved-password');
  await expect(page).toHaveURL(new RegExp(`/settings\\?account=${second}#access$`));
  await page.getByLabel('Confirm new password', { exact: true }).fill('unsaved-password');
  await expect(
    page.getByRole('button', { name: 'Enable password protection', exact: true }),
  ).toBeEnabled();
  await page.getByRole('link', { name: 'Accounts', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add account', exact: true })).toBeEnabled();
});

test('a dialog follows the visible viewport when a phone keyboard opens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/settings#account');
  await page.getByRole('button', { name: 'Rename Twitch 123456', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await page.evaluate(() => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: 300 },
      offsetTop: { configurable: true, value: 60 },
    });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect
    .poll(async () => {
      const box = (await dialog.boundingBox())!;
      return box.y >= 76 && box.y + box.height <= 344;
    })
    .toBe(true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
});
