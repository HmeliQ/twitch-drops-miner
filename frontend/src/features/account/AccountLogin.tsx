import { useEffect, useRef, useState } from 'react';
import { Icon } from '@mdi/react';
import { mdiCheck, mdiContentCopy, mdiOpenInNew } from '@mdi/js';
import { useAccounts, accountTarget, validAccountLabel } from '../../app/accounts';
import { useT } from '../../shared/lib/i18n';
import { safeUrl } from '../../shared/lib/api';
import {
  ActionResult,
  Art,
  Button,
  Check,
  Dialog,
  Field,
  HelpButton,
  IconButton,
  Input,
  Notice,
  useAction,
} from '../../shared/ui';
import { accountName } from './AccountSwitcher';

export default function AccountLogin({ onClose }: { onClose: () => void }) {
  const { overview, action, select } = useAccounts();
  const login = overview?.login;
  const t = useT();
  const command = useAction();
  const [label, setLabel] = useState('');
  const [confirmedAttempt, setConfirmedAttempt] = useState<string | null>(null);
  const [source, setSource] = useState('');
  const [autoClaim, setAutoClaim] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copyTimer = useRef<number | undefined>(undefined);
  const copyRequest = useRef(0);
  useEffect(() => {
    setCopyState('idle');
    return () => {
      copyRequest.current += 1;
      window.clearTimeout(copyTimer.current);
    };
  }, [login?.id, login?.code?.code]);
  async function copyCode(code: string) {
    const request = ++copyRequest.current;
    let state: 'copied' | 'failed' = 'copied';
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      state = 'failed';
    }
    if (request !== copyRequest.current) return;
    window.clearTimeout(copyTimer.current);
    setCopyState(state);
    if (state === 'copied') copyTimer.current = window.setTimeout(() => setCopyState('idle'), 3000);
  }
  const accounts = overview?.accounts ?? [];
  const duplicate = login?.user_id
    ? accounts.find((account) => account.user_id === login.user_id && account.id !== login.target)
    : undefined;
  const target = accounts.find((account) => account.id === login?.target);
  const mismatch = !!target?.user_id && !!login?.user_id && target.user_id !== login.user_id;
  useEffect(() => {
    setLabel('');
    setSource('');
    setAutoClaim(false);
  }, [login?.id]);
  async function cancel() {
    if (await command.run(() => action({ action: 'cancel_login', attempt: login!.id }))) onClose();
  }
  return (
    <Dialog
      open={!!login}
      title={t(login?.target ? 'accounts_reconnect' : 'accounts_add')}
      onClose={() => {
        if (!command.busy) onClose();
      }}
    >
      {login && (
        <div className="space-y-4">
          {login.error ? (
            <Notice error>{t(login.error)}</Notice>
          ) : login.user_id ? (
            <>
              <div className="flex items-center gap-3">
                <Art url={login.avatar_url} className="rounded-full!" />
                <span className="min-w-0 break-words font-medium">
                  {login.name || login.user_id}
                </span>
              </div>
              {mismatch ? (
                <Notice error>{t('account_identity_mismatch')}</Notice>
              ) : duplicate ? (
                <Notice>{t('accounts_duplicate', { name: accountName(duplicate) })}</Notice>
              ) : (
                <>
                  <Field
                    label={t('accounts_label')}
                    detail={t('accounts_label_help')}
                    help={!validAccountLabel(label) ? t('accounts_label_invalid') : undefined}
                  >
                    <Input
                      value={label}
                      maxLength={100}
                      aria-invalid={!validAccountLabel(label)}
                      onChange={(event) => setLabel(event.target.value)}
                      placeholder={login.name ?? ''}
                    />
                  </Field>
                  {!login.target && (
                    <Field
                      label={t('accounts_initial_preferences')}
                      detail={t('accounts_copy_help')}
                    >
                      <select
                        className="field"
                        value={source}
                        onChange={(event) => setSource(event.target.value)}
                      >
                        <option value="">{t('accounts_fresh_preferences')}</option>
                        {accounts
                          .filter((account) => account.user_id && !account.unavailable)
                          .map((account) => (
                            <option key={account.id} value={account.id}>
                              {accountName(account)}
                            </option>
                          ))}
                      </select>
                    </Field>
                  )}
                  {source && (
                    <>
                      <Check
                        label={t('accounts_copy_auto_claim')}
                        checked={autoClaim}
                        onChange={setAutoClaim}
                      />
                    </>
                  )}
                </>
              )}
            </>
          ) : login.code ? (
            <>
              <div className="authorization-row">
                <div className="flex items-center gap-2 rounded border border-divider bg-field ps-3 pe-1">
                  <code className="select-all text-lg tracking-[.2em]">{login.code.code}</code>
                  <IconButton
                    path={copyState === 'copied' ? mdiCheck : mdiContentCopy}
                    label={t('copy_code')}
                    title={t(copyState === 'copied' ? 'code_copied' : 'copy_code')}
                    className="size-7 max-md:size-9"
                    onClick={() => void copyCode(login.code!.code)}
                  />
                </div>
                <a
                  className="button"
                  href={safeUrl(login.code.url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  {t('gui.login.oauth_activate')}
                  <Icon path={mdiOpenInNew} className="mdi-icon" />
                </a>
                <Button
                  disabled={command.busy || login.confirmed || confirmedAttempt === login.id}
                  aria-busy={command.busy || login.confirmed || confirmedAttempt === login.id}
                  onClick={async () => {
                    if (
                      await command.run(() =>
                        action({ action: 'confirm_login', attempt: login.id }),
                      )
                    )
                      setConfirmedAttempt(login.id);
                  }}
                >
                  {t('gui.login.oauth_confirm')}
                </Button>
                <HelpButton label={t('accounts_add')} text={t('accounts_login_help')} />
              </div>
              {copyState === 'copied' && (
                <span className="sr-only" role="status">
                  {t('code_copied')}
                </span>
              )}
              {copyState === 'failed' && <Notice error>{t('copy_code_failed')}</Notice>}
            </>
          ) : (
            <p role="status" className="text-muted">
              {t('accounts_preparing_login')}
            </p>
          )}
          <ActionResult action={command} />
          <div className="flex flex-wrap justify-end gap-2">
            <Button disabled={command.busy} onClick={() => void cancel()}>
              {t('cancel')}
            </Button>
            {!!login.user_id && !mismatch && !login.error && (
              <Button
                primary
                disabled={command.busy || !validAccountLabel(label)}
                onClick={() =>
                  void command.run(async () => {
                    const from = accounts.find((account) => account.id === source);
                    const result = await action<{ id: string }>({
                      action: 'finish_login',
                      attempt: login.id,
                      label,
                      copy_from: from ? accountTarget(from) : null,
                      copy_auto_claim: autoClaim,
                    });
                    select(result.id);
                    onClose();
                  })
                }
              >
                {t(
                  duplicate
                    ? 'accounts_view_existing'
                    : target
                      ? 'accounts_reconnect'
                      : 'accounts_finish',
                )}
              </Button>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
}
