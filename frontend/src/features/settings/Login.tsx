import { useState } from 'react';
import { mdiReload } from '@mdi/js';
import logo from '../../assets/twitch-drops-miner-logo.svg?no-inline';
import { useT } from '../../shared/lib/i18n';
import { request } from '../../shared/lib/api';
import {
  Button,
  IconButton,
  Check,
  Field,
  Input,
  Notice,
  useAction,
  ActionResult,
} from '../../shared/ui/index';
export default function Login({
  onLogin,
  statusError = false,
}: {
  onLogin: () => Promise<void>;
  statusError?: boolean;
}) {
  const t = useT();
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(false);
  const action = useAction();
  return (
    <main className="login-page grid min-h-dvh place-items-center">
      <div className="w-full max-w-sm">
        <div className="mb-8 flex items-center gap-3">
          <img
            src={logo}
            alt=""
            width={37}
            height={48}
            className="h-12 w-9 shrink-0 object-contain"
          />
          <span className="font-semibold tracking-tight">Drops Miner</span>
        </div>
        <h1 className="text-[22px] font-semibold">{t('gui.auth.login_title')}</h1>
        <p className="mb-6 mt-2 text-muted">{t('login_description')}</p>
        {statusError && (
          <div className="mb-5 space-y-3">
            <Notice error>{t('server_unavailable')}</Notice>
            <IconButton
              path={mdiReload}
              label={t('retry')}
              disabled={action.busy}
              onClick={() => void action.run(onLogin)}
            />
          </div>
        )}
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void action.run(async () => {
              await request('/api/auth/login', { password, remember });
              setPassword('');
              await onLogin();
            });
          }}
        >
          <Field label={t('gui.auth.password')}>
            <Input
              type="password"
              name="password"
              autoComplete="current-password"
              autoFocus
              required
              maxLength={1024}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <Check label={t('gui.auth.remember')} checked={remember} onChange={setRemember} />
          <ActionResult action={action} />
          <Button type="submit" primary disabled={action.busy || !password} className="w-full">
            {t(action.busy ? 'loading' : 'gui.auth.login')}
          </Button>
        </form>
      </div>
    </main>
  );
}
