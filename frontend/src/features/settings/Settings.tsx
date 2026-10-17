import { Link } from '../../app/accountNavigation';
import Telegram from './Telegram';
import { DesktopUpdates } from './DesktopUpdates';
import UpdateCheck from './UpdateCheck';
import { isDesktop } from '../../shared/lib/platform';
import { DesktopSettings } from './Desktop';
import { Icon } from '@mdi/react';
import { useLocation, useNavigate } from 'react-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  mdiAccountOutline,
  mdiShieldLockOutline,
  mdiLanConnect,
  mdiWrenchOutline,
  mdiMonitor,
  mdiBellOutline,
  mdiTune,
  mdiArrowLeft,
  mdiChevronRight,
} from '@mdi/js';
import type { AuthStatus, ReleaseInfo } from '../../shared/lib/types';
import { request, safeUrl } from '../../shared/lib/api';
import { useMiner } from '../../app/MinerProvider';
import { useT } from '../../shared/lib/i18n';
import Accounts from '../account/Accounts';
import Connection from './Connection';
import { useAccounts } from '../../app/accounts';
import {
  ActionResult,
  Button,
  Dialog,
  Field,
  HelpButton,
  Input,
  Notice,
  useAction,
} from '../../shared/ui/index';
function Section({
  id,
  children,
  hidden = false,
}: {
  id: string;
  children: ReactNode;
  hidden?: boolean;
}) {
  return (
    <section id={`settings-${id}`} hidden={hidden} className="grid min-w-0 grid-cols-1 gap-4">
      {children}
    </section>
  );
}
function Access({
  initial,
  disabled,
  hidden,
}: {
  initial: AuthStatus;
  disabled: boolean;
  hidden: boolean;
}) {
  const t = useT();
  const [auth, setAuth] = useState(initial);
  useEffect(() => setAuth(initial), [initial]);
  const [current, setCurrent] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [disableDialog, setDisableDialog] = useState(false);
  const action = useAction();
  async function save(kind: 'enable' | 'change' | 'disable') {
    await action.run(async () => {
      const result = await request<AuthStatus>('/api/auth/settings', {
        action: kind,
        current_password: current,
        password,
        confirm_password: confirm,
      });
      setAuth({ ...auth, enabled: result.enabled });
      setCurrent('');
      setPassword('');
      setConfirm('');
      setDisableDialog(false);
      window.dispatchEvent(new Event('auth-updated'));
    });
  }
  return (
    <Section hidden={hidden} id="access">
      <div className="flex items-center gap-1">
        <p className="muted">{t(auth.enabled ? 'gui.auth.enabled' : 'gui.auth.disabled')}</p>
        <HelpButton label={t('access')} text={t('gui.auth.help')} />
      </div>
      {disabled && <Notice>{t('save_first')}</Notice>}
      <form
        className="grid max-w-md gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          void save(auth.enabled ? 'change' : 'enable');
        }}
      >
        {auth.enabled && (
          <Field label={t('gui.auth.current_password')}>
            <Input
              type="password"
              autoComplete="current-password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              required
              maxLength={1024}
            />
          </Field>
        )}
        <Field label={t('gui.auth.new_password')}>
          <Input
            type="password"
            autoComplete="new-password"
            minLength={8}
            maxLength={1024}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
          />
        </Field>
        <Field label={t('gui.auth.confirm_password')}>
          <Input
            type="password"
            autoComplete="new-password"
            maxLength={1024}
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            required
          />
        </Field>
        <ActionResult action={action} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={disabled || action.busy} primary>
            {t(auth.enabled ? 'gui.auth.change' : 'gui.auth.enable')}
          </Button>
          {auth.enabled && (
            <Button
              disabled={disabled || action.busy || !current}
              onClick={() => setDisableDialog(true)}
            >
              {t('disable_protection')}
            </Button>
          )}
        </div>
      </form>
      <Dialog
        open={disableDialog}
        title={t('disable_protection')}
        onClose={() => setDisableDialog(false)}
      >
        <p className="text-muted">{t('disable_help')}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setDisableDialog(false)}>{t('cancel')}</Button>
          <Button primary disabled={action.busy} onClick={() => void save('disable')}>
            {t('disable_protection')}
          </Button>
        </div>
        <ActionResult action={action} />
      </Dialog>
    </Section>
  );
}
function ReleaseNotice({ disabled }: { disabled: boolean }) {
  const t = useT();
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [busy, setBusy] = useState(true);
  const controller = useRef<AbortController | null>(null);
  async function check() {
    controller.current?.abort();
    const next = new AbortController();
    controller.current = next;
    setBusy(true);
    try {
      const result = await request<ReleaseInfo>('/api/version', undefined, 'GET', next.signal);
      if (!next.signal.aborted) setRelease(result);
    } catch {
      if (!next.signal.aborted)
        setRelease((previous) => previous && { ...previous, check_succeeded: false });
    } finally {
      if (!next.signal.aborted) setBusy(false);
    }
  }
  useEffect(() => {
    void check();
    return () => controller.current?.abort();
  }, []);
  const available = release?.check_succeeded && release.update_available;
  const releaseUrl = available ? safeUrl(release.download_url) : undefined;
  return (
    <div className="grid gap-4 text-[13px]">
      <UpdateCheck
        version={release?.current_version}
        checking={busy}
        disabled={disabled}
        onCheck={() => void check()}
      >
        {busy ? (
          <p role="status" className="text-muted">
            {t('checking_updates')}
          </p>
        ) : !release?.check_succeeded ? (
          <p role="status" className="text-muted">
            {t('update_check_failed')}
          </p>
        ) : available ? (
          <p role="status" className="text-muted">
            {t('update_available', { version: release.latest_version ?? '' })}
          </p>
        ) : (
          <p role="status" className="text-muted">
            {t('up_to_date')}
          </p>
        )}
      </UpdateCheck>
      {available && !busy && releaseUrl && (
        <a
          className="text-link justify-self-start"
          href={releaseUrl}
          target="_blank"
          rel="noreferrer"
        >
          {t('release_notes')}
        </a>
      )}
    </div>
  );
}

function SettingsContent({ auth }: { auth: AuthStatus }) {
  const { data, connected, autosave, request: scopedRequest } = useMiner();
  const accounts = useAccounts();
  const t = useT();
  const location = useLocation();
  const navigate = useNavigate();
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 1023px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1023px)');
    const resize = () => setCompact(media.matches);
    media.addEventListener('change', resize);
    return () => media.removeEventListener('change', resize);
  }, []);
  const sections = [
    ['mining', mdiTune, 'mining_preferences'],
    ['account', mdiAccountOutline, 'accounts'],
    ['notifications', mdiBellOutline, 'notifications'],
    ['connection', mdiLanConnect, 'connection'],
    isDesktop()
      ? ['desktop', mdiMonitor, 'gui.desktop.tab']
      : ['access', mdiShieldLockOutline, 'access'],
    ['maintenance', mdiWrenchOutline, 'maintenance'],
  ] as const;
  const section =
    sections.find(([id]) => `#${id}` === location.hash)?.[0] ?? (compact ? null : 'account');
  useEffect(() => {
    if (!compact && !location.hash)
      void navigate(
        { pathname: location.pathname, search: location.search, hash: '#account' },
        { replace: true, state: location.state },
      );
  }, [compact, location, navigate]);
  const heading = useRef<HTMLHeadingElement>(null);
  const navigation = useRef<HTMLElement>(null);
  const previousSection = useRef(section);
  useEffect(() => {
    const returning =
      location.state?.settingsFocus === 'mining' && (!compact || !section)
        ? 'mining'
        : compact && !section
          ? previousSection.current
          : null;
    window.scrollTo(0, 0);
    if (returning) {
      navigation.current
        ?.querySelector<HTMLAnchorElement>(`[data-section="${returning}"]`)
        ?.focus({ preventScroll: true });
    } else if (compact) {
      heading.current?.focus({ preventScroll: true });
    }
    previousSection.current = section;
  }, [section, compact, location.key]);
  const [confirmation, setConfirmation] = useState<{
    title: string;
    text: string;
    action: () => Promise<unknown>;
  } | null>(null);
  const command = useAction();
  const dirty = autosave.pending || autosave.busy;
  return (
    <div className="flex max-w-5xl flex-col gap-6 lg:gap-8">
      <header className="flex items-center gap-3">
        {compact && section && (
          <Link
            to="/settings"
            className="icon-button"
            aria-label={t('back_to_settings')}
            title={t('back_to_settings')}
          >
            <Icon path={mdiArrowLeft} className="mdi-icon" />
          </Link>
        )}
        <h1 ref={heading} tabIndex={-1} className="text-[22px] font-semibold">
          {t(
            compact && section ? sections.find(([id]) => id === section)![2] : 'gui.tabs.settings',
          )}
        </h1>
      </header>
      <nav
        ref={navigation}
        hidden={compact && section !== null}
        aria-label={t('settings_sections')}
        className="settings-navigation text-[13px] text-muted"
      >
        {sections.map(([id, icon, label]) => (
          <Link
            className={`settings-tab ${section === id ? 'active' : ''}`}
            aria-current={section === id ? 'page' : undefined}
            key={id}
            id={`settings-link-${id}`}
            data-section={id}
            to={id === 'mining' ? '/?edit=priorities' : `#${id}`}
            state={id === 'mining' ? { preferencesFromSettings: true } : undefined}
          >
            <Icon path={icon} className="mdi-icon" />
            {t(label)}
            {compact && <Icon path={mdiChevronRight} className="mdi-icon ms-auto" />}
          </Link>
        ))}
      </nav>
      <Section hidden={section !== 'account'} id="account">
        <Accounts />
      </Section>
      {section === 'connection' && (
        <Section id="connection">
          <Connection />
        </Section>
      )}
      {isDesktop() ? (
        <Section hidden={section !== 'desktop'} id="desktop">
          <DesktopSettings />
        </Section>
      ) : (
        <Access
          hidden={section !== 'access'}
          initial={auth}
          disabled={dirty || !accounts.connected}
        />
      )}
      {section === 'notifications' && <Telegram connected={accounts.connected} />}
      <Section hidden={section !== 'maintenance'} id="maintenance">
        {isDesktop() ? <DesktopUpdates /> : <ReleaseNotice disabled={!accounts.connected} />}
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={!connected || command.busy || !data}
            onClick={() =>
              setConfirmation({
                title: t('gui.settings.clear_all_cache'),
                text: t('accounts_cache_help', {
                  name:
                    accounts.overview?.accounts.find((account) => account.id === accounts.selected)
                      ?.name || t('account'),
                }),
                action: () => scopedRequest('/api/cache/clear', {}),
              })
            }
          >
            {t('gui.settings.clear_all_cache')}
          </Button>
        </div>
        {!isDesktop() && (
          <details>
            <summary className="text-[13px] text-muted">{t('advanced')}</summary>
            <Button
              className="mt-3"
              disabled={!accounts.connected || command.busy}
              onClick={() =>
                setConfirmation({
                  title: t('shutdown'),
                  text: t('shutdown_help'),
                  action: () => request('/api/close', {}),
                })
              }
            >
              {t('shutdown')}
            </Button>
          </details>
        )}
        <ActionResult action={command} />
        <div className="space-y-2 text-[13px] text-muted">
          <p>
            {t('help_link_accounts')}{' '}
            <a
              className="text-link"
              href="https://www.twitch.tv/drops/campaigns"
              target="_blank"
              rel="noreferrer"
            >
              Twitch
            </a>
          </p>
          <a
            className="text-link inline-block"
            href="https://github.com/ohne-b/twitch-drops-miner"
            target="_blank"
            rel="noreferrer"
          >
            {t('source_license')}
          </a>
        </div>
      </Section>
      <Dialog
        open={confirmation !== null}
        title={confirmation?.title ?? ''}
        onClose={() => setConfirmation(null)}
      >
        <p className="text-muted">{confirmation?.text}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button onClick={() => setConfirmation(null)}>{t('cancel')}</Button>
          <Button
            primary
            disabled={command.busy}
            onClick={() =>
              void command.run(async () => {
                await confirmation?.action();
                setConfirmation(null);
              })
            }
          >
            {t('gui.settings.confirm_btn')}
          </Button>
        </div>
        <ActionResult action={command} />
      </Dialog>
    </div>
  );
}
export default function Settings({ auth }: { auth: AuthStatus }) {
  return <SettingsContent auth={auth} />;
}
