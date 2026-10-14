import { useEffect, useState } from 'react';
import { Icon } from '@mdi/react';
import {
  mdiAccountPlusOutline,
  mdiContentCopy,
  mdiDotsHorizontal,
  mdiOpenInNew,
  mdiPause,
  mdiPlay,
} from '@mdi/js';
import {
  useAccounts,
  accountTarget,
  validAccountLabel,
  type AccountSummary,
  type BulkResult,
} from '../../app/accounts';
import { useMiner } from '../../app/MinerProvider';
import { useT } from '../../shared/lib/i18n';
import {
  ActionResult,
  Art,
  Button,
  Check,
  Dialog,
  Empty,
  Field,
  IconButton,
  Input,
  useAction,
} from '../../shared/ui';
import { accountName, accountStatus } from './AccountSwitcher';
import AccountIdentity, { AccountBadges } from './Account';
import AccountLogin from './AccountLogin';

export default function Accounts() {
  const { overview, selected, connected, action, select } = useAccounts();
  const { data } = useMiner();
  const accounts = overview?.accounts ?? [];
  const t = useT();
  const command = useAction();
  const [checked, setChecked] = useState<string[]>([]);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [retryPause, setRetryPause] = useState<boolean | null>(null);
  const [retryCopy, setRetryCopy] = useState<{ source: string; autoClaim: boolean } | null>(null);
  const [menu, setMenu] = useState<AccountSummary | null>(null);
  const [operation, setOperation] = useState<'rename' | 'sign_out' | 'remove' | 'associate' | null>(
    null,
  );
  const [label, setLabel] = useState('');
  const [associate, setAssociate] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const [copy, setCopy] = useState(false);
  const [copySource, setCopySource] = useState('');
  const [copyAutoClaim, setCopyAutoClaim] = useState(false);
  const ids = accounts.map((account) => account.id).join(',');
  useEffect(
    () =>
      setChecked((previous) =>
        previous.filter((id) => accounts.some((account) => account.id === id)),
      ),
    [ids],
  );
  const targets = accounts.filter((account) => checked.includes(account.id));
  const disabled = !connected || command.busy;
  const failures = result?.results.filter((result) => !result.ok) ?? [];
  async function pause(paused: boolean, ids = checked) {
    setRetryPause(paused);
    setRetryCopy(null);
    await command.run(async () =>
      setResult(
        await action<BulkResult>({
          action: 'pause',
          paused,
          targets: accounts.filter((account) => ids.includes(account.id)).map(accountTarget),
        }),
      ),
    );
  }
  async function copyPreferences(sourceId: string, autoClaim: boolean, ids = checked) {
    const source = accounts.find((account) => account.id === sourceId);
    if (!source) return;
    setRetryPause(null);
    setRetryCopy({ source: sourceId, autoClaim });
    await command.run(async () => {
      setResult(
        await action<BulkResult>({
          action: 'copy_preferences',
          source: accountTarget(source),
          auto_claim: autoClaim,
          targets: accounts
            .filter((account) => ids.includes(account.id) && account.id !== sourceId)
            .map(accountTarget),
        }),
      );
      setCopy(false);
    });
  }
  async function login(account?: AccountSummary) {
    if (account?.unassigned && !associate) {
      setMenu(account);
      setOperation('associate');
      return;
    }
    if (
      await command.run(() =>
        action({
          action: 'start_login',
          target: account?.id ?? null,
          associate_existing: !!account?.unassigned,
        }),
      )
    ) {
      setMenu(null);
      setOperation(null);
      setAssociate(false);
      setLoginOpen(true);
    }
  }
  function openMenu(account: AccountSummary) {
    command.clear();
    setMenu(account);
    setOperation(null);
    setLabel(account.label);
    setAssociate(false);
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-[13px] text-muted">{t('accounts_overview_help')}</p>
        <Button
          disabled={disabled || (!overview?.login && accounts.length >= (overview?.limit ?? 20))}
          onClick={() => (overview?.login ? setLoginOpen(true) : void login())}
        >
          <Icon path={mdiAccountPlusOutline} className="mdi-icon" />
          {t(overview?.login ? 'accounts_continue_login' : 'accounts_add')}
        </Button>
      </div>
      {accounts.length >= (overview?.limit ?? 20) && (
        <p className="text-xs text-muted">{t('account_limit')}</p>
      )}
      {!!accounts.length && (
        <div className="overflow-hidden rounded border border-divider">
          <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 border-b border-divider px-4 py-2">
            <Check
              label={
                checked.length
                  ? t('accounts_selected', { count: checked.length })
                  : t('accounts_select_all')
              }
              checked={checked.length === accounts.length}
              onChange={(value) => setChecked(value ? accounts.map((account) => account.id) : [])}
            />
            {!!targets.length && (
              <div className="ms-auto flex flex-wrap gap-2">
                <Button disabled={disabled} onClick={() => void pause(true)}>
                  <Icon path={mdiPause} className="mdi-icon" />
                  {t('accounts_pause')}
                </Button>
                <Button disabled={disabled} onClick={() => void pause(false)}>
                  <Icon path={mdiPlay} className="mdi-icon" />
                  {t('accounts_resume')}
                </Button>
                <IconButton
                  path={mdiContentCopy}
                  label={t('accounts_copy')}
                  disabled={disabled || accounts.length < 2}
                  onClick={() => {
                    command.clear();
                    setResult(null);
                    setRetryPause(null);
                    setCopySource(selected ?? accounts[0]?.id ?? '');
                    setCopyAutoClaim(false);
                    setCopy(true);
                  }}
                />
              </div>
            )}
          </div>
          <div
            className="max-h-[min(55dvh,540px)] overflow-y-auto overscroll-contain divide-y divide-divider"
            aria-label={t('accounts')}
          >
            {accounts.map((account) => (
              <div key={account.id} className="flex min-h-20 items-center gap-3 px-4 py-3">
                <label className="flex min-h-11 shrink-0 items-center">
                  <input
                    type="checkbox"
                    className="size-4 accent-soft"
                    checked={checked.includes(account.id)}
                    onChange={(event) =>
                      setChecked((previous) =>
                        event.target.checked
                          ? [...previous, account.id]
                          : previous.filter((id) => id !== account.id),
                      )
                    }
                  />
                  <span className="sr-only">
                    {t('accounts_select', { name: accountName(account) || t('account') })}
                  </span>
                </label>
                <Art url={account.avatar_url} className="size-9! rounded-full!" />
                <div className="min-w-0 flex-1">
                  <button
                    type="button"
                    className="text-link max-w-full truncate text-start font-medium"
                    aria-current={selected === account.id ? 'true' : undefined}
                    onClick={() => select(account.id)}
                  >
                    {accountName(account) || t('account')}
                  </button>
                  <p className="truncate text-[13px] text-muted">
                    {t(accountStatus(account))}
                    {account.connected && !account.paused && account.game
                      ? `: ${account.game}`
                      : ''}
                  </p>
                  {account.connected && !account.paused && account.reward && (
                    <p className="truncate text-xs text-muted">{account.reward}</p>
                  )}
                </div>
                {!account.connected && !account.unavailable && (
                  <Button
                    disabled={disabled}
                    className="shrink-0"
                    onClick={() => void login(account)}
                  >
                    {t('accounts_sign_in')}
                  </Button>
                )}
                {account.unavailable && (
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      void command.run(() => action({ action: 'retry', id: account.id }))
                    }
                  >
                    {t('retry')}
                  </Button>
                )}
                <IconButton
                  path={mdiDotsHorizontal}
                  label={t('accounts_actions', { name: accountName(account) || t('account') })}
                  disabled={disabled}
                  onClick={() => openMenu(account)}
                />
              </div>
            ))}
          </div>
        </div>
      )}
      {!accounts.length && <Empty title={t('accounts_empty')} detail={t('accounts_empty_help')} />}
      <ActionResult action={command} />
      {result && (
        <div className="space-y-2" role="status">
          <p className="text-[13px] text-muted">
            {t('accounts_bulk_result', {
              count: result.results.filter((result) => result.ok).length,
              total: result.results.length,
            })}
          </p>
          {!!failures.length && (
            <>
              <ul className="space-y-1 text-[13px]">
                {failures.map((failure) => (
                  <li key={failure.id}>
                    {accountName(
                      accounts.find((account) => account.id === failure.id) ??
                        ({ label: failure.id } as AccountSummary),
                    )}
                    :{' '}
                    {t(
                      failure.error === 'settings_conflict'
                        ? 'settings_conflict'
                        : 'accounts_action_failed',
                    )}
                  </li>
                ))}
              </ul>
              {(retryPause !== null || retryCopy) && (
                <Button
                  disabled={disabled}
                  onClick={() =>
                    void (retryCopy
                      ? copyPreferences(
                          retryCopy.source,
                          retryCopy.autoClaim,
                          failures.map((failure) => failure.id),
                        )
                      : pause(
                          retryPause!,
                          failures.map((failure) => failure.id),
                        ))
                  }
                >
                  {t('accounts_retry_failed')}
                </Button>
              )}
            </>
          )}
        </div>
      )}
      {data?.login.user_id && (
        <details className="pt-2">
          <summary className="cursor-pointer text-[13px] text-muted">
            {t('accounts_profile')}
          </summary>
          <div className="space-y-4 pt-4">
            <div className="flex items-center gap-2">
              <AccountIdentity profile={data.login.profile} />
              {data.login.profile?.login && (
                <a
                  className="icon-button"
                  aria-label={t('open_twitch_profile')}
                  title={t('open_twitch_profile')}
                  href={`https://www.twitch.tv/${encodeURIComponent(data.login.profile.login)}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon path={mdiOpenInNew} className="mdi-icon" />
                </a>
              )}
            </div>
            <AccountBadges key={data.login.user_id} profile={data.login.profile} />
          </div>
        </details>
      )}
      <Dialog
        open={!!menu}
        title={menu ? accountName(menu) || t('account') : ''}
        onClose={() => {
          if (!command.busy) {
            setMenu(null);
            setOperation(null);
          }
        }}
      >
        {menu && (
          <div className="space-y-4">
            {!operation ? (
              <div className="grid gap-2">
                <Button onClick={() => setOperation('rename')}>{t('accounts_rename')}</Button>
                {menu.connected && (
                  <Button onClick={() => setOperation('sign_out')}>{t('twitch_logout')}</Button>
                )}
                <Button onClick={() => setOperation('remove')}>{t('accounts_remove')}</Button>
              </div>
            ) : (
              <>
                {operation === 'rename' ? (
                  <Field
                    label={t('accounts_label')}
                    help={t(
                      validAccountLabel(label) ? 'accounts_label_help' : 'accounts_label_invalid',
                    )}
                  >
                    <Input
                      value={label}
                      maxLength={100}
                      aria-invalid={!validAccountLabel(label)}
                      onChange={(event) => setLabel(event.target.value)}
                    />
                  </Field>
                ) : (
                  <p className="text-[13px] text-muted">
                    {t(
                      operation === 'associate'
                        ? 'accounts_associate_help'
                        : operation === 'sign_out'
                          ? 'accounts_sign_out_help'
                          : 'accounts_remove_help',
                    )}
                  </p>
                )}
                {operation === 'associate' && (
                  <Check
                    label={t('accounts_associate_confirm')}
                    checked={associate}
                    onChange={setAssociate}
                  />
                )}
                <div className="flex justify-end gap-2">
                  <Button disabled={command.busy} onClick={() => setOperation(null)}>
                    {t('cancel')}
                  </Button>
                  <Button
                    primary
                    disabled={
                      command.busy ||
                      (operation === 'associate' && !associate) ||
                      (operation === 'rename' && !validAccountLabel(label))
                    }
                    onClick={() =>
                      void (operation === 'associate'
                        ? login(menu)
                        : command.run(async () => {
                            await action({
                              action: operation,
                              id: menu.id,
                              ...(operation === 'rename' ? { label } : {}),
                            });
                            if (operation === 'remove' && menu.id === selected) {
                              const next = accounts.find((account) => account.id !== menu.id);
                              if (next) select(next.id);
                            }
                            setMenu(null);
                            setOperation(null);
                          }))
                    }
                  >
                    {t(
                      operation === 'remove'
                        ? 'accounts_remove'
                        : operation === 'sign_out'
                          ? 'twitch_logout'
                          : operation === 'associate'
                            ? 'accounts_sign_in'
                            : 'accounts_save',
                    )}
                  </Button>
                </div>
              </>
            )}
            <ActionResult action={command} />
          </div>
        )}
      </Dialog>
      <Dialog
        open={copy}
        title={t('accounts_copy')}
        onClose={() => {
          if (!command.busy) setCopy(false);
        }}
      >
        <div className="space-y-4">
          <p className="text-[13px] text-muted">{t('accounts_copy_help')}</p>
          <Field label={t('accounts_copy_from')}>
            <select
              className="field"
              value={copySource}
              onChange={(event) => setCopySource(event.target.value)}
            >
              {accounts
                .filter((account) => !account.unavailable)
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {accountName(account) || t('account')}
                  </option>
                ))}
            </select>
          </Field>
          <p className="text-[13px] text-muted">
            {t('accounts_copy_to', {
              names:
                targets
                  .filter((account) => account.id !== copySource)
                  .map(accountName)
                  .join(', ') || t('accounts_no_targets'),
            })}
          </p>
          <Check
            label={t('accounts_copy_auto_claim')}
            checked={copyAutoClaim}
            onChange={setCopyAutoClaim}
          />
          <ActionResult action={command} />
          <div className="flex justify-end gap-2">
            <Button disabled={command.busy} onClick={() => setCopy(false)}>
              {t('cancel')}
            </Button>
            <Button
              primary
              disabled={disabled || !targets.some((account) => account.id !== copySource)}
              onClick={() => void copyPreferences(copySource, copyAutoClaim)}
            >
              {t('accounts_copy')}
            </Button>
          </div>
        </div>
      </Dialog>
      {loginOpen && <AccountLogin onClose={() => setLoginOpen(false)} />}
    </div>
  );
}
