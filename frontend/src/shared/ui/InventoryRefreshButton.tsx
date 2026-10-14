import { useEffect, useState } from 'react';
import { mdiRefresh, mdiCheck, mdiAlertCircleOutline } from '@mdi/js';
import { useMiner } from '../../app/MinerProvider';
import { useT } from '../lib/i18n';
import { IconButton, dateTime, useAction } from './index';

export function InventoryRefreshButton() {
  const { data, connected, request } = useMiner();
  const t = useT();
  const action = useAction();
  const refresh = data?.inventory_refresh;
  const sequence = refresh?.sequence ?? 0;
  const [dismissed, setDismissed] = useState(-1);
  useEffect(() => {
    action.clear();
  }, [sequence]);
  useEffect(() => {
    if (refresh?.state !== 'refreshed') return;
    const timer = window.setTimeout(() => setDismissed(sequence), 4000);
    return () => window.clearTimeout(timer);
  }, [refresh?.state, sequence]);
  const busy = action.busy || refresh?.state === 'refreshing';
  const error = action.error || refresh?.error;
  const failed = !busy && (Boolean(error) || refresh?.state === 'failed');
  const done = !busy && !failed && refresh?.state === 'refreshed' && dismissed !== sequence;
  const catalogTime = data?.inventory_status?.catalog_updated_at;
  const label = t(busy ? 'refreshing' : failed ? 'refresh_failed' : done ? 'refreshed' : 'refresh');
  const detail = failed
    ? (error ?? t('refresh_failed_detail'))
    : catalogTime
      ? t('catalog_updated', { time: dateTime(catalogTime) })
      : undefined;
  return (
    <>
      <IconButton
        path={failed ? mdiAlertCircleOutline : done ? mdiCheck : mdiRefresh}
        label={label}
        className={busy ? '[&>svg]:animate-spin motion-reduce:[&>svg]:animate-none' : ''}
        disabled={!connected || !data?.login.user_id || busy}
        aria-busy={busy}
        aria-description={detail}
        title={detail ? `${label}\n${detail}` : label}
        onClick={() => void action.run(() => request('/api/reload', {}))}
      />
      <span className="sr-only" aria-live="polite">
        {label}
      </span>
    </>
  );
}
