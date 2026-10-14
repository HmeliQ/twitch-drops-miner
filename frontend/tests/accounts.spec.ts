import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import fixture from './fixture.json' with { type: 'json' };
import type { AccountsOverview } from '../src/app/accounts';

const headers = { 'X-TDM-Request': '1' };
const second = '00000000000000000000000000000001';
const third = '00000000000000000000000000000002';
const overview = async (request: APIRequestContext): Promise<AccountsOverview> =>
  (await request.get('/api/accounts')).json();
const settings = async (request: APIRequestContext, id: string) =>
  (await request.get(`/api/accounts/${id}/settings`)).json();
async function switchTo(page: Page, name: string) {
  await page
    .getByRole('button', { name: 'Switch account', exact: true })
    .filter({ visible: true })
    .click();
  await page
    .getByRole('group', { name: 'Switch account', exact: true })
    .getByRole('button', { name: new RegExp(`^${name}`) })
    .click();
}
async function seed(request: APIRequestContext, count = 2) {
  const snapshots = Array.from({ length: count }, (_, index) => ({
    ...fixture,
    login: {
      status: 'Logged in',
      user_id: 200 + index,
      profile: {
        display_name: `Account ${index + 2}`,
        login: `account${index + 2}`,
        avatar_url: null,
        color: null,
        badges: [],
        available_badges: [],
      },
    },
    settings: {
      ...fixture.settings,
      games_to_watch: index % 2 ? ['Other'] : ['Rust'],
      mining_paused: index % 2 === 1,
      auto_claim_drops: false,
    },
    current_drop: fixture.current_drop
      ? { ...fixture.current_drop, drop_name: `Reward ${index + 2}` }
      : null,
  }));
  expect((await request.post('/__test/accounts', { headers, data: snapshots })).ok()).toBe(true);
}
test.beforeEach(async ({ request, page }) => {
  await request.post('/__test/reset', { headers, data: {} });
  page.on('pageerror', (error) => {
    throw error;
  });
});

for (const width of [1440, 390, 320]) {
  test(`account overview, bulk controls and switcher fit ${width}px`, async ({ page, request }) => {
    await seed(request, 19);
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/settings#account');
    await expect(
      page.getByRole('checkbox', { name: 'Select Account 20', exact: true }),
    ).toBeAttached();
    await expect(page.getByRole('button', { name: 'Add account', exact: true })).toBeDisabled();
    await page.getByRole('checkbox', { name: 'Select all', exact: true }).check();
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Updated 20 of 20 accounts.');
    expect((await overview(request)).accounts.every((account) => account.paused)).toBe(true);
    await page.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect
      .poll(async () => (await overview(request)).accounts.every((account) => !account.paused))
      .toBe(true);
    await page
      .getByRole('button', { name: 'Switch account', exact: true })
      .filter({ visible: true })
      .click();
    const picker = page.getByRole('group', { name: 'Switch account', exact: true });
    await picker.getByRole('searchbox').fill('Account 20');
    await expect(picker.getByRole('button')).toHaveCount(2); // Result and clear-search control.
    await picker.getByRole('button', { name: /^Account 20/ }).click();
    await expect(page).toHaveURL(/account=00000000000000000000000000000013/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.screenshot({ path: `../artifacts/accounts-${width}.png` });
  });
}

test('switching retains account views and sends a pending preference save to its original account', async ({
  page,
  request,
}) => {
  await seed(request);
  await page.goto('/?edit=priorities');
  const automatic = page.getByRole('checkbox', { name: 'Automatically claim drops', exact: true });
  await automatic.uncheck();
  await switchTo(page, 'Account 2');
  await expect(automatic).not.toBeChecked();
  await automatic.check();
  await switchTo(page, 'Twitch 123456');
  await expect(automatic).not.toBeChecked();
  await expect.poll(async () => (await settings(request, 'primary')).auto_claim_drops).toBe(false);
  await expect.poll(async () => (await settings(request, second)).auto_claim_drops).toBe(true);
  expect((await settings(request, third)).auto_claim_drops).toBe(false);
  await page.getByRole('link', { name: 'Campaigns', exact: true }).click();
  await page
    .getByRole('searchbox', { name: 'Search campaigns and rewards', exact: true })
    .fill('Rust');
  await switchTo(page, 'Account 2');
  await expect(page).toHaveURL(/edit=priorities/);
  await switchTo(page, 'Twitch 123456');
  await expect(
    page.getByRole('searchbox', { name: 'Search campaigns and rewards', exact: true }),
  ).toHaveValue('Rust');
});

test('bulk actions keep successful accounts and retry only failures after a revision conflict', async ({
  page,
  request,
}) => {
  await seed(request);
  await page.goto('/settings#account');
  await page.getByRole('checkbox', { name: 'Select all', exact: true }).check();
  let conflict = true;
  const targets: string[][] = [];
  await page.route('**/api/accounts', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const action = route.request().postDataJSON();
    if (action.action === 'pause') {
      targets.push(action.targets.map((target: { id: string }) => target.id));
      if (conflict) {
        conflict = false;
        const before = await settings(request, second);
        await request.post(`/api/accounts/${second}/settings`, {
          headers,
          data: { revision: before.revision, games_to_watch: ['Changed elsewhere'] },
        });
      }
    }
    await route.continue();
  });
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Updated 2 of 3 accounts.');
  await page.getByRole('button', { name: 'Retry failed accounts', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Updated 1 of 1 accounts.');
  expect(targets).toEqual([['primary', second, third], [second]]);
  expect((await settings(request, second)).games_to_watch).toEqual(['Changed elsewhere']);
});

test('copying preferences preserves target pause and automatic claims unless explicitly included', async ({
  page,
  request,
}) => {
  await seed(request);
  const original = await settings(request, third);
  await page.goto('/settings#account');
  await page.getByRole('checkbox', { name: 'Select Account 3', exact: true }).check();
  await page.getByRole('button', { name: 'Copy mining preferences', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy mining preferences', exact: true });
  await dialog.getByRole('combobox').selectOption('primary');
  await expect(
    dialog.getByRole('checkbox', { name: 'Also copy automatic claiming' }),
  ).not.toBeChecked();
  await dialog.getByRole('button', { name: 'Copy mining preferences', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const copied = await settings(request, third);
  expect(copied.games_to_watch).toEqual((await settings(request, 'primary')).games_to_watch);
  expect(copied.mining_paused).toBe(original.mining_paused);
  expect(copied.auto_claim_drops).toBe(original.auto_claim_drops);
});

test('device sign-in verifies an account before adding it and removal keeps other accounts running', async ({
  page,
  request,
}) => {
  await seed(request);
  await page.goto('/settings#account');
  await page.getByRole('button', { name: 'Add account', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Add account', exact: true });
  await expect(dialog.locator('code')).toHaveText('TESTCODE');
  expect((await overview(request)).accounts).toHaveLength(3);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Display label', exact: true })).toBeVisible();
  await dialog.getByRole('textbox').fill('Weekend');
  await dialog.getByRole('button', { name: 'Add account', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(async () => (await overview(request)).accounts.length).toBe(4);
  await page.getByRole('button', { name: 'Actions for Account 2', exact: true }).click();
  const actions = page.getByRole('dialog', { name: 'Account 2', exact: true });
  await actions.getByRole('button', { name: 'Remove account', exact: true }).click();
  await expect(actions).toContainText('Its local data is kept');
  await actions.getByRole('button', { name: 'Remove account', exact: true }).click();
  await expect.poll(async () => (await overview(request)).accounts.length).toBe(3);
  expect(
    (await overview(request)).accounts.find((account) => account.id === 'primary')?.connected,
  ).toBe(true);
});

test('shared connection changes require save and cannot be written through a scoped settings request', async ({
  page,
  request,
}) => {
  await seed(request);
  await page.goto('/settings#connection');
  const quality = page.getByRole('combobox', { name: 'Connection Quality:', exact: true });
  await quality.selectOption('5');
  await switchTo(page, 'Account 2');
  await expect(quality).toHaveValue('5');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  expect((await settings(request, 'primary')).connection_quality).toBe(5);
  expect((await settings(request, second)).connection_quality).toBe(5);
  const before = await settings(request, second);
  expect(
    (
      await request.post(`/api/accounts/${second}/settings`, {
        headers,
        data: { revision: before.revision, connection_quality: 2 },
      })
    ).status(),
  ).toBe(400);
});

for (const form of ['connection', 'notifications']) {
  test(`an accepted ${form} save stays busy across account switches`, async ({ page, request }) => {
    await seed(request);
    await page.goto(`/settings#${form}`);
    const field =
      form === 'connection'
        ? page.getByRole('combobox', { name: 'Connection Quality:', exact: true })
        : page.getByLabel('Chat ID', { exact: true });
    if (form === 'connection') await field.selectOption('5');
    else await field.fill('42');
    let release!: () => void;
    let accepted = false;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      form === 'connection' ? '**/api/accounts' : '**/api/telegram',
      async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        accepted = true;
        await held;
        await route.fulfill({ response });
      },
    );
    try {
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect.poll(() => accepted).toBe(true);
      await switchTo(page, 'Account 2');
      await expect(field).toBeDisabled();
      await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
    } finally {
      release();
    }
    await expect(field).toBeEnabled();
    await expect(field).toHaveValue(form === 'connection' ? '5' : '42');
  });
}

test('back navigation and copied campaign links retain their original account', async ({
  page,
  request,
}) => {
  await seed(request);
  await page.goto('/campaigns');
  await expect(page).toHaveURL(/account=primary/);
  await switchTo(page, 'Account 2');
  await expect(page).toHaveURL(new RegExp(`account=${second}`));
  await page.goBack();
  await expect(page).toHaveURL(/account=primary/);
  await expect(page.locator('.account-trigger')).toContainText('Twitch 123456');
  await page.getByRole('link', { name: 'Mining', exact: true }).click();
  await expect(page.locator('#mining-drop-details')).toHaveAttribute('href', /account=primary/);
  await switchTo(page, 'Account 2');
  await page.getByRole('link', { name: 'Mining', exact: true }).click();
  await expect(page.locator('#mining-drop-details')).toHaveAttribute(
    'href',
    new RegExp(`account=${second}`),
  );
});

test('an unavailable account stops subscriptions and Retry reconnects the same selected profile', async ({
  page,
  request,
}) => {
  await seed(request);
  await page.goto(`/settings?account=${second}#account`);
  await expect(page.locator('.account-trigger')).toContainText('Account 2');
  expect(
    (
      await request.post('/__test/event', {
        headers,
        data: { account: second, event: 'account_unavailable', data: null },
      })
    ).ok(),
  ).toBe(true);
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  const connections: string[] = [];
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).searchParams.get('account') === second)
      connections.push(socket.url());
  });
  await page.waitForTimeout(1500);
  expect(connections).toEqual([]);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toHaveCount(0);
  await page.getByRole('link', { name: 'Mining', exact: true }).click();
  await page.getByRole('link', { name: 'Edit', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Automatically claim drops', exact: true }),
  ).toBeEnabled();
  await expect(page).toHaveURL(new RegExp(`account=${second}`));
  expect(
    (await overview(request)).accounts.find((account) => account.id === 'primary')?.connected,
  ).toBe(true);
});

test('offline account management disables writes and reconnects without changing the viewed account', async ({
  page,
  request,
}) => {
  await seed(request);
  await page.goto(`/settings?account=${second}#account`);
  const add = page.getByRole('button', { name: 'Add account', exact: true });
  await expect(add).toBeEnabled();
  await page.getByRole('checkbox', { name: 'Select all', exact: true }).check();
  const pause = page.getByRole('button', { name: 'Pause', exact: true });
  await expect(pause).toBeEnabled();
  try {
    await page.context().setOffline(true);
    await expect(add).toBeDisabled();
    await expect(pause).toBeDisabled();
  } finally {
    await page.context().setOffline(false);
  }
  await expect(add).toBeEnabled();
  await expect(pause).toBeEnabled();
  await expect(page.locator('.account-trigger')).toContainText('Account 2');
  await expect(page).toHaveURL(new RegExp(`account=${second}`));
});

test('copy source stays valid when an account becomes unavailable or is removed', async ({
  page,
  request,
}) => {
  await seed(request);
  await page.goto(`/settings?account=${second}#account`);
  await request.post('/__test/event', {
    headers,
    data: { account: second, event: 'account_unavailable', data: null },
  });
  await expect(page.getByRole('button', { name: 'Try again', exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: 'Select Account 3', exact: true }).check();
  await page.getByRole('button', { name: 'Copy mining preferences', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Copy mining preferences', exact: true });
  const source = dialog.getByRole('combobox');
  await expect(source).toHaveValue('primary');
  const copy = dialog.getByRole('button', { name: 'Copy mining preferences', exact: true });
  await copy.click();
  await expect(dialog).not.toBeVisible();
  expect((await settings(request, third)).games_to_watch).toEqual(
    (await settings(request, 'primary')).games_to_watch,
  );
  await page.getByRole('button', { name: 'Copy mining preferences', exact: true }).click();
  await expect(source).toHaveValue('primary');
  await source.selectOption(third);
  await request.post('/api/accounts', { headers, data: { action: 'remove', id: third } });
  await expect(source).toHaveValue('primary');
  await expect(copy).toBeDisabled();
});
