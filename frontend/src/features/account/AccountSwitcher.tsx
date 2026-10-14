import { Link } from '../../app/accountNavigation';
import { useCallback, useState } from 'react';
import { Icon } from '@mdi/react';
import { mdiAccountMultipleOutline, mdiCheck } from '@mdi/js';
import { useAccounts, type AccountSummary } from '../../app/accounts';
import { useMiner } from '../../app/MinerProvider';
import AccountIdentity from './Account';
import { useT } from '../../shared/lib/i18n';
import { Art, Search } from '../../shared/ui';
import AnchoredPopover from '../../shared/ui/AnchoredPopover';

export function accountName(account: AccountSummary) {
  return account.label || account.name || (account.user_id ? String(account.user_id) : '');
}

export function accountStatus(account: AccountSummary): string {
  if (account.unavailable) return 'accounts_unavailable';
  if (account.unassigned) return 'accounts_unassigned';
  if (!account.connected) return 'accounts_signed_out';
  if (account.paused) return 'accounts_paused';
  if (['watching', 'awaiting_progress', 'manual_watching'].includes(account.mining))
    return 'accounts_mining';
  if (account.mining === 'discovering') return 'accounts_discovering';
  if (account.mining === 'manual_offline' || account.mining === 'waiting_channel')
    return 'accounts_waiting';
  return 'accounts_idle';
}

export default function AccountSwitcher({ compact = false }: { compact?: boolean }) {
  const { overview, selected, select } = useAccounts();
  const { data } = useMiner();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const close = useCallback(() => {
    setOpen(false);
    setSearch('');
  }, []);
  const t = useT();
  const accounts = overview?.accounts ?? [];
  const current = accounts.find((account) => account.id === selected);
  return (
    <AnchoredPopover
      label={t('accounts_switch')}
      icon={mdiAccountMultipleOutline}
      open={open}
      maxHeight={460}
      onToggle={() => setOpen(!open)}
      onClose={close}
      triggerClass={
        compact
          ? 'icon-button size-11 shrink-0'
          : 'account-trigger mt-1 flex min-h-11 w-full min-w-0 items-center gap-2 rounded text-start'
      }
      triggerContent={
        <>
          {!compact && current && data?.login.profile ? (
            <span className="min-w-0 flex-1">
              <AccountIdentity
                compact
                profile={{
                  ...data.login.profile,
                  display_name: current.label || data.login.profile.display_name,
                }}
              />
            </span>
          ) : current ? (
            <Art url={current.avatar_url} className="size-7! rounded-full!" />
          ) : (
            <Icon path={mdiAccountMultipleOutline} className="mdi-icon" />
          )}
          {!compact && !data?.login.profile && (
            <span className="min-w-0 flex-1 truncate">
              {current ? accountName(current) || t('account') : t('accounts')}
            </span>
          )}
        </>
      }
    >
      {accounts.length > 6 && (
        <div className="shrink-0 p-3">
          <Search value={search} onChange={setSearch} label={t('accounts_search')} />
        </div>
      )}
      <div className="min-h-0 overflow-y-auto overscroll-contain p-1">
        {accounts
          .filter((account) =>
            accountName(account).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
          )
          .map((account) => (
            <button
              key={account.id}
              type="button"
              aria-pressed={account.id === selected}
              className="flex min-h-14 w-full items-center gap-3 rounded px-3 py-2 text-start hover:bg-field"
              onClick={() => {
                select(account.id);
                close();
              }}
            >
              <Art url={account.avatar_url} className="size-8! rounded-full!" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-soft">
                  {accountName(account) || t('account')}
                </span>
                <span className="block truncate text-xs text-muted">
                  {t(accountStatus(account))}
                  {account.connected && !account.paused && account.game ? `: ${account.game}` : ''}
                </span>
              </span>
              {account.id === selected && <Icon path={mdiCheck} className="mdi-icon shrink-0" />}
            </button>
          ))}
      </div>
      <div className="shrink-0 border-t border-divider p-3">
        <Link className="text-link" to="/settings#account" onClick={close}>
          {t('accounts_manage')}
        </Link>
      </div>
    </AnchoredPopover>
  );
}
