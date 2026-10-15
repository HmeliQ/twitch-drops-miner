import { io, type Socket } from 'socket.io-client';
import type { AuthStatus, ServerEvents } from '../shared/lib/types';
import { request } from '../shared/lib/api';
import type { StateAction } from './reducer';

export interface Subscription {
  resync(): void;
  close(): void;
}

export function connectBrowser(
  receive: (action: StateAction) => void,
  account?: string,
): Subscription {
  const socket: Socket<ServerEvents, { state_resync: () => void }> = io({
    autoConnect: false,
    query: { protocol: '2', ...(account ? { account } : {}) },
  });
  let disposed = false;
  let incompatible = false;
  let reconnectTimer: number | undefined;
  let failures = 0;
  const controller = new AbortController();
  const checkAuth = (reconnect = false) => {
    void request<AuthStatus>('/api/auth/status', undefined, 'GET', controller.signal)
      .then((auth) => {
        if (disposed) return;
        if (!auth.authenticated) window.dispatchEvent(new Event('auth-expired'));
        else {
          window.dispatchEvent(new Event('auth-updated'));
          if (reconnect && !incompatible) {
            clearTimeout(reconnectTimer);
            reconnectTimer = window.setTimeout(
              () => socket.connect(),
              Math.min(1000 * 2 ** Math.min(failures++, 4), 10_000),
            );
          }
        }
      })
      .catch(() => {});
  };
  const mismatch = () => {
    incompatible = true;
    receive({ type: 'incompatible' });
  };
  socket.on('state_snapshot', (value) => {
    failures = 0;
    receive({ type: 'snapshot', value });
  });
  socket.on('state_patch', (value) => receive({ type: 'patch', value }));
  socket.on('protocol_mismatch', mismatch);
  socket.on('initial_state', mismatch);
  socket.on('disconnect', (reason) => {
    receive({ type: 'disconnect' });
    checkAuth(reason === 'io server disconnect');
  });
  socket.on('connect_error', () => {
    receive({ type: 'disconnect' });
    checkAuth();
  });
  socket.on('notification', (value) => {
    if (account) return;
    if ('Notification' in window && Notification.permission === 'granted')
      new Notification(value.title, { body: value.message });
  });
  const offline = () => {
    socket.disconnect();
    receive({ type: 'disconnect' });
  };
  const online = () => {
    if (!incompatible) socket.connect();
  };
  window.addEventListener('offline', offline);
  window.addEventListener('online', online);
  socket.connect();
  return {
    resync: () => socket.emit('state_resync'),
    close: () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      controller.abort();
      window.removeEventListener('offline', offline);
      window.removeEventListener('online', online);
      socket.removeAllListeners();
      socket.disconnect();
    },
  };
}
