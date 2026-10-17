import type { ActionState } from '../../shared/ui';
import { useCallback, useEffect, useState } from 'react';
import { mdiContentSave, mdiDeleteOutline, mdiOpenInNew, mdiChevronDown } from '@mdi/js';
import { Icon } from '@mdi/react';
import { ApiError, request } from '../../shared/lib/api';
import { useAccounts, useSharedState } from '../../app/accounts';
import AnchoredPopover from '../../shared/ui/AnchoredPopover';
import { accountName } from '../account/AccountSwitcher';
import { useT } from '../../shared/lib/i18n';
import {
  ActionResult,
  Button,
  Check,
  Field,
  HelpButton,
  Input,
  IconButton,
  Notice,
  useAction,
} from '../../shared/ui';

interface Configuration {
  enabled: boolean;
  remote_control: boolean;
  include_image: boolean;
  notification_accounts: number[] | null;
  token_configured: boolean;
  chat_id: string;
  revision: string;
  unreadable: boolean;
}

interface BotIdentity {
  revision: string;
  bot: { name: string; username: string } | null;
}

export default function Telegram({ connected }: { connected: boolean }) {
  const t = useT();
  const { overview } = useAccounts();
  const accounts = (overview?.accounts ?? []).filter((account) => account.user_id !== null);
  const [selectedAccounts, setSelectedAccounts] = useSharedState<number[] | null>(
    'telegram.accounts',
    null,
  );
  const selectedCount = accounts.filter((account) =>
    selectedAccounts?.includes(account.user_id!),
  ).length;
  const [accountsOpen, setAccountsOpen] = useState(false);
  const closeAccounts = useCallback(() => setAccountsOpen(false), []);
  const action = useAction(
    useSharedState<ActionState>('telegram.action', { busy: false, error: '', success: '' }),
  );
  const [saved, setSaved] = useSharedState<Configuration | undefined>('telegram.saved', undefined);
  const [identity, setIdentity] = useState<BotIdentity>();
  const [enabled, setEnabled] = useSharedState('telegram.enabled', false);
  const [remoteControl, setRemoteControl] = useSharedState('telegram.remote', false);
  const [includeImage, setIncludeImage] = useSharedState('telegram.image', false);
  const [chat, setChat] = useSharedState('telegram.chat', '');
  const [token, setToken] = useSharedState('telegram.token', '');
  const [loadFailed, setLoadFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useEffect(() => {
    if (
      action.busy ||
      (saved &&
        (enabled !== saved.enabled ||
          remoteControl !== saved.remote_control ||
          includeImage !== saved.include_image ||
          JSON.stringify(selectedAccounts) !==
            JSON.stringify(saved.notification_accounts ?? null) ||
          chat !== saved.chat_id ||
          token !== ''))
    )
      return;
    const controller = new AbortController();
    setSaved(undefined);
    setToken('');
    setLoadFailed(false);
    void request<Configuration>('/api/telegram', undefined, 'GET', controller.signal)
      .then((value) => {
        if (controller.signal.aborted) return;
        setSaved(value);
        setEnabled(value.enabled);
        setRemoteControl(value.remote_control);
        setIncludeImage(value.include_image);
        setSelectedAccounts(value.notification_accounts ?? null);
        setChat(value.chat_id);
      })
      .catch(() => {
        if (!controller.signal.aborted) setLoadFailed(true);
      });
    return () => controller.abort();
  }, [reload]);
  useEffect(() => {
    if (!saved?.token_configured || !connected) return;
    const controller = new AbortController();
    void request<BotIdentity>('/api/telegram/bot', undefined, 'GET', controller.signal)
      .then((value) => {
        if (!controller.signal.aborted) setIdentity(value);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [saved?.revision, saved?.token_configured, connected]);
  const bot = !token && identity?.revision === saved?.revision ? identity?.bot : undefined;
  const dirty =
    !!saved &&
    (enabled !== saved.enabled ||
      remoteControl !== saved.remote_control ||
      includeImage !== saved.include_image ||
      JSON.stringify(selectedAccounts) !== JSON.stringify(saved.notification_accounts ?? null) ||
      chat !== saved.chat_id ||
      token !== '');
  async function save(remove = false) {
    if (!saved) return;
    await action.run(async () => {
      const value = await request<Configuration>('/api/telegram', {
        revision: saved.revision,
        enabled,
        remote_control: remoteControl,
        include_image: includeImage,
        notification_accounts: selectedAccounts,
        chat_id: chat,
        token,
        remove,
      }).catch((error: unknown) => {
        if (error instanceof ApiError && error.message === 'settings_conflict')
          throw new ApiError(error.status, 'telegram_conflict');
        throw error;
      });
      setSaved(value);
      setEnabled(value.enabled);
      setRemoteControl(value.remote_control);
      setIncludeImage(value.include_image);
      setSelectedAccounts(value.notification_accounts ?? null);
      setChat(value.chat_id);
      setToken('');
    });
  }
  return (
    <section id="settings-notifications" className="grid min-w-0 max-w-md grid-cols-1 gap-4">
      <div className="flex items-center gap-1">
        <h2 className="font-semibold">Telegram</h2>
        <HelpButton
          label="Telegram"
          text={`${t('telegram_help')} ${t('accounts_telegram_help')} ${t('telegram_accounts_help')}`}
        />
        {bot && (
          <a
            href={`https://t.me/${encodeURIComponent(bot.username)}`}
            target="_blank"
            rel="noreferrer"
            aria-label={t('telegram_open_bot', { name: bot.name })}
            title={`@${bot.username}`}
            className="ml-auto inline-flex min-w-0 max-w-[60%] items-center gap-1 text-muted hover:text-text"
          >
            <span className="truncate underline underline-offset-4">{bot.name}</span>
            <Icon path={mdiOpenInNew} className="mdi-icon" />
          </a>
        )}
      </div>
      {loadFailed ? (
        <Notice error>{t('gui.auth.request_failed')}</Notice>
      ) : (
        !saved && <p className="text-muted">{t('loading')}</p>
      )}
      {loadFailed && (
        <Button onClick={() => setReload((value) => value + 1)}>{t('telegram_retry')}</Button>
      )}
      {saved && (
        <form
          className="grid gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {saved.unreadable && <Notice error>{t('gui.auth.telegram_storage')}</Notice>}
          <fieldset
            disabled={!connected || action.busy || saved.unreadable}
            className="grid min-w-0 gap-4"
          >
            <div className="grid gap-1">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Check
                  label={t('telegram_enabled')}
                  checked={enabled}
                  onChange={(value) => {
                    action.clear();
                    setEnabled(value);
                  }}
                />
                {enabled && (
                  <AnchoredPopover
                    label={t('telegram_accounts')}
                    icon={mdiChevronDown}
                    open={accountsOpen}
                    maxHeight={320}
                    onToggle={() => setAccountsOpen(!accountsOpen)}
                    onClose={closeAccounts}
                    triggerClass="button min-w-0 text-xs"
                    triggerContent={
                      <>
                        {selectedAccounts === null
                          ? t('telegram_accounts_all')
                          : selectedCount
                            ? t(
                                selectedCount === 1
                                  ? 'telegram_accounts_one'
                                  : 'telegram_accounts_count',
                                { count: selectedCount },
                              )
                            : t('telegram_accounts_none')}
                        <Icon path={mdiChevronDown} className="mdi-icon size-4!" />
                      </>
                    }
                  >
                    <div className="shrink-0 border-b border-divider px-3 py-2">
                      <Check
                        label={t('telegram_accounts_all')}
                        checked={selectedAccounts === null}
                        onChange={(value) => {
                          action.clear();
                          setSelectedAccounts(value ? null : []);
                        }}
                      />
                    </div>
                    <div className="min-h-0 overflow-y-auto overscroll-contain p-3 space-y-2">
                      {accounts.map((account) => (
                        <Check
                          key={account.id}
                          label={accountName(account)}
                          checked={
                            selectedAccounts === null || selectedAccounts.includes(account.user_id!)
                          }
                          onChange={(value) => {
                            action.clear();
                            const ids = selectedAccounts ?? accounts.map((entry) => entry.user_id!);
                            setSelectedAccounts(
                              value
                                ? [...new Set([...ids, account.user_id!])].sort((a, b) => a - b)
                                : ids.filter((id) => id !== account.user_id),
                            );
                          }}
                        />
                      ))}
                      {!accounts.length && (
                        <p className="text-muted text-xs">{t('accounts_empty')}</p>
                      )}
                    </div>
                  </AnchoredPopover>
                )}
              </div>
              <Check
                label={t('telegram_include_image')}
                checked={includeImage}
                onChange={(value) => {
                  action.clear();
                  setIncludeImage(value);
                }}
              />
              <div className="flex items-center gap-1">
                <Check
                  label={t('telegram_remote_control')}
                  checked={remoteControl}
                  onChange={(value) => {
                    action.clear();
                    setRemoteControl(value);
                  }}
                />
                <HelpButton
                  label={t('telegram_remote_control')}
                  text={t('telegram_control_help')}
                />
              </div>
            </div>
            <Field label={t('telegram_bot_token')}>
              <Input
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                maxLength={256}
                placeholder={saved.token_configured ? t('telegram_token_saved') : ''}
                value={token}
                onChange={(event) => {
                  action.clear();
                  setToken(event.target.value);
                }}
              />
            </Field>
            <Field label={t('telegram_chat_id')}>
              <Input
                value={chat}
                maxLength={24}
                spellCheck={false}
                onChange={(event) => {
                  action.clear();
                  setChat(event.target.value);
                }}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" primary disabled={!dirty}>
                <Icon path={mdiContentSave} className="mdi-icon" />
                {t('telegram_save')}
              </Button>
              <Button
                disabled={dirty || !(saved.enabled || saved.remote_control)}
                onClick={() =>
                  void action.run(() => request('/api/telegram/test', {}), t('telegram_test_sent'))
                }
              >
                {t('telegram_test')}
              </Button>
              {saved.token_configured && (
                <IconButton
                  path={mdiDeleteOutline}
                  label={t('telegram_remove')}
                  onClick={() => void save(true)}
                />
              )}
            </div>
          </fieldset>
          <ActionResult action={action} />
        </form>
      )}
    </section>
  );
}
