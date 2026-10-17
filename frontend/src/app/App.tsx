import { Link, NavLink, useAccountPath } from './accountNavigation';
import { DesktopUpdateLink, DesktopUpdateProvider } from '../features/settings/DesktopUpdates';
import { isDesktop } from '../shared/lib/platform';
import { DesktopStartupError, DesktopStatus } from '../features/settings/Desktop';
import { Icon } from '@mdi/react';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useRef, useState } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router';
import {
  mdiPlayCircleOutline,
  mdiReload,
  mdiGiftOutline,
  mdiTextBoxOutline,
  mdiCogOutline,
  mdiLogout,
  mdiGithub,
} from '@mdi/js';
import type { AuthStatus } from '../shared/lib/types';
import { request } from '../shared/lib/api';
import { I18n, useT } from '../shared/lib/i18n';
import { MinerProvider, useMiner } from './MinerProvider';
import { miningTitle } from './title';
import { Button, Empty, Notice, IconButton } from '../shared/ui/index';
import Mining from '../features/mining/Mining';
import { useUpNextState } from '../features/mining/UpNext';
import Campaigns from '../features/campaigns/Campaigns';
import Activity from '../features/activity/Activity';
import Settings from '../features/settings/Settings';
import AccountSwitcher from '../features/account/AccountSwitcher';
import { AccountsProvider, useAccounts } from './accounts';
import { clearAutosaveDrafts } from './useAutosave';
import Login from '../features/settings/Login';
import logo from '../assets/twitch-drops-miner-logo.svg?no-inline';
function Shell({ auth, onLogout }: { auth: AuthStatus; onLogout: () => Promise<void> }) {
  const { data, connected, incompatible, autosave } = useMiner();
  const accounts = useAccounts();
  const viewed = accounts.overview?.accounts.find((account) => account.id === accounts.selected);
  const upNext = useUpNextState(data);
  useEffect(() => {
    if (connected) {
      const frame = requestAnimationFrame(accounts.restoreView);
      return () => cancelAnimationFrame(frame);
    }
  }, [connected, accounts.restoreView]);
  const t = useT();
  const baseTitle = miningTitle(data, connected, t);
  const title =
    accounts.overview && accounts.overview.accounts.length > 1 && viewed
      ? `${viewed.label || viewed.name} - ${baseTitle}`
      : baseTitle;
  useEffect(() => {
    document.title = title;
    if (isDesktop()) void invoke('desktop_title', { title }).catch(() => {});
    return () => {
      document.title = 'Drops Miner';
    };
  }, [title]);
  const location = useLocation();
  const preferencesPath = useAccountPath('/?edit=priorities');
  const navigationType = useNavigationType();
  const previousLocation = useRef(location);
  const [logoutError, setLogoutError] = useState(false);
  const links = [
    ['/', 'mining', mdiPlayCircleOutline],
    ['/campaigns', 'campaigns', mdiGiftOutline],
    ['/activity', 'activity', mdiTextBoxOutline],
    ['/settings', 'gui.tabs.settings', mdiCogOutline],
  ] as const;
  useEffect(() => {
    const previous = previousLocation.current;
    previousLocation.current = location;
    if (
      navigationType === 'POP' &&
      previous.state?.preferencesFromSettings === true &&
      location.pathname === '/settings'
    ) {
      const frame = requestAnimationFrame(() => {
        const trigger = document.getElementById('settings-link-mining');
        if (trigger?.getClientRects().length) trigger.focus({ preventScroll: true });
        window.scrollTo(0, 0);
      });
      return () => cancelAnimationFrame(frame);
    }
    const origin = previous.state?.campaignReturn;
    if (
      navigationType === 'POP' &&
      origin?.path === location.pathname + location.search + location.hash
    ) {
      const frame = requestAnimationFrame(() => {
        for (const [id, top, width] of origin.lists as [string, number, number][]) {
          const list = document.getElementById(id);
          if (list?.clientWidth === width) list.scrollTop = top;
        }
        window.scrollTo(0, origin.width === window.innerWidth ? origin.top : 0);
        const trigger = document.getElementById(origin.focus);
        trigger?.focus({ preventScroll: true });
        trigger?.scrollIntoView({ block: 'nearest' });
      });
      return () => cancelAnimationFrame(frame);
    }
    if (previous.pathname === location.pathname) return;
    if (location.search.includes('campaign=')) return;
    window.scrollTo(0, 0);
  }, [location, navigationType]);
  return (
    <div className="app-shell min-h-dvh">
      <a href="#main" className="sr-only fixed z-50 bg-soft p-3 text-canvas focus:not-sr-only">
        {t('skip_content')}
      </a>
      <aside className="app-sidebar">
        <div className="brand-row flex min-w-0 shrink-0 items-center gap-2 px-4">
          <NavLink
            to="/"
            aria-label="Drops Miner"
            className="flex shrink-0 items-center gap-2 whitespace-nowrap text-base font-semibold tracking-tight"
          >
            <img
              src={logo}
              alt=""
              width={31}
              height={40}
              className="brand-logo h-10 w-[31px] shrink-0 object-contain"
            />
            <span className="brand-name">Drops Miner</span>
          </NavLink>
          <div className="ms-auto min-w-0 lg:hidden">
            <AccountSwitcher compact />
          </div>
        </div>
        <nav aria-label={t('navigation')} className="primary-nav">
          {links.map(([to, label, icon]) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}
            >
              <Icon path={icon} className="mdi-icon" />
              {t(label)}
            </NavLink>
          ))}
        </nav>
        <div className="min-w-0 lg:mt-auto lg:p-4">
          <div className="flex min-w-0 items-center gap-2">
            <a
              className="icon-button hidden size-11 shrink-0 lg:inline-flex"
              href="https://github.com/ohne-b/twitch-drops-miner"
              target="_blank"
              rel="noreferrer"
              aria-label="GitHub repository"
              title="GitHub"
            >
              {/* The glyph fills 20 of its 24 viewBox units: render its artwork at 32px. */}
              <Icon path={mdiGithub} className="mdi-icon size-[38.4px]!" />
            </a>
            {isDesktop() && <DesktopUpdateLink />}
          </div>
          <div className="hidden lg:block">
            <AccountSwitcher />
            {auth.enabled && (
              <Button
                className="mt-3 w-full"
                onClick={() => void onLogout().catch(() => setLogoutError(true))}
              >
                <Icon className="mdi-icon" path={mdiLogout} />
                {t('gui.auth.logout')}
              </Button>
            )}
          </div>
        </div>
      </aside>
      <main id="main" tabIndex={-1} className="workspace min-w-0">
        <div
          className={`mx-auto max-w-[1440px] ${location.pathname === '/' ? (new URLSearchParams(location.search).get('edit') === 'priorities' ? 'preferences-frame' : 'mining-frame') : location.pathname === '/campaigns' ? 'campaigns-frame' : location.pathname === '/activity' ? 'activity-frame' : ''}`}
        >
          {accounts.error && <Notice error>{t(accounts.error)}</Notice>}
          {!accounts.connected && (
            <Notice>{t(accounts.overview ? 'disconnected_help' : 'connecting')}</Notice>
          )}
          {accounts.connected && accounts.selected && !viewed?.unavailable && !connected && (
            <div className="mb-5">
              <Notice>
                {t(incompatible ? 'client_outdated' : data ? 'disconnected_help' : 'connecting')}
                {isDesktop() && !incompatible && (
                  <Button
                    onClick={() => void invoke('restart_app').catch(() => setLogoutError(true))}
                  >
                    {t('gui.desktop.restart')}
                  </Button>
                )}
                {incompatible && (
                  <IconButton
                    path={mdiReload}
                    label={t('reload_dashboard')}
                    onClick={autosave.reload}
                  />
                )}
              </Notice>
            </div>
          )}
          {isDesktop() && <DesktopStatus />}
          {logoutError && <Notice error>{t('gui.auth.request_failed')}</Notice>}
          {auth.enabled && (
            <div className="mb-4 text-end lg:hidden">
              <Button onClick={() => void onLogout().catch(() => setLogoutError(true))}>
                {t('gui.auth.logout')}
              </Button>
            </div>
          )}
          {autosave.error && (
            <Notice error>
              {t(autosave.error)}{' '}
              <IconButton
                path={mdiReload}
                label={t('retry')}
                disabled={!connected || autosave.busy}
                onClick={() => void autosave.retry()}
              />
            </Notice>
          )}
          {accounts.overview &&
          location.pathname !== '/settings' &&
          (!accounts.selected || viewed?.unavailable) ? (
            <Empty
              title={t(viewed?.unavailable ? 'accounts_unavailable' : 'accounts_empty')}
              detail={t(viewed?.unavailable ? 'accounts_unavailable_help' : 'accounts_empty_help')}
            >
              <Link className="button" to="/settings#account">
                {t('accounts_manage')}
              </Link>
            </Empty>
          ) : (
            <Routes>
              <Route path="/" element={<Mining upNext={upNext} />} />
              <Route path="/campaigns" element={<Campaigns />} />
              <Route path="/history" element={<Navigate to="/campaigns?tab=history" replace />} />
              <Route path="/activity" element={<Activity />} />
              <Route
                path="/settings"
                element={
                  location.hash === '#mining' ? (
                    <Navigate
                      to={preferencesPath}
                      state={{ preferencesFromSettings: true }}
                      replace
                    />
                  ) : (
                    <Settings auth={auth} />
                  )
                }
              />
              <Route path="/login" element={<Navigate to="/" replace />} />
              <Route path="*" element={<Empty title={t('not_found')} />} />
            </Routes>
          )}
        </div>
      </main>
    </div>
  );
}
export default function App() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [error, setError] = useState(false);
  const navigate = useNavigate();
  const t = useT();
  async function refresh() {
    const state = await request<AuthStatus>('/api/auth/status');
    if (!state.authenticated) clearAutosaveDrafts();
    setAuth(state);
    setError(false);
    if (state.authenticated && location.pathname === '/login') navigate('/', { replace: true });
  }
  useEffect(() => {
    void refresh().catch(() => setError(true));
    const expire = () => {
      clearAutosaveDrafts();
      setAuth((current) => ({ ...current, enabled: true, authenticated: false }));
      navigate('/login', { replace: true });
    };
    window.addEventListener('auth-expired', expire);
    const updated = () => {
      void refresh().catch(() => setError(true));
    };
    window.addEventListener('auth-updated', updated);
    return () => {
      window.removeEventListener('auth-expired', expire);
      window.removeEventListener('auth-updated', updated);
    };
  }, []);
  if (!auth && error)
    return isDesktop() ? <DesktopStartupError /> : <Login onLogin={refresh} statusError />;
  if (!auth) return <Empty title={t('loading')} />;
  if (!auth.authenticated)
    return (
      <I18n messages={{ gui: { auth: auth.translations ?? {} } }}>
        <Login onLogin={refresh} />
      </I18n>
    );
  return (
    <AccountsProvider>
      <DesktopUpdateProvider>
        <AccountShell
          auth={auth}
          onLogout={async () => {
            await request('/api/auth/logout', {});
            await refresh();
          }}
        />
      </DesktopUpdateProvider>
    </AccountsProvider>
  );
}

function AccountShell(props: { auth: AuthStatus; onLogout: () => Promise<void> }) {
  const { selected, overview, error, refresh } = useAccounts();
  const t = useT();
  if (!overview)
    return (
      <Empty title={t(error || 'loading')}>
        {error && <Button onClick={() => void refresh().catch(() => {})}>{t('retry')}</Button>}
      </Empty>
    );
  const account = overview.accounts.find((account) => account.id === selected);
  return (
    <MinerProvider
      key={`${selected}:${account?.instance}:${account?.unavailable}`}
      accountId={selected}
      available={!!account && !account.unavailable}
    >
      <Shell {...props} />
    </MinerProvider>
  );
}
