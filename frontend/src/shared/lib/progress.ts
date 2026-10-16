import type { translator } from './i18n';
import type { Progress, Settings } from './types';

export function formatProgressTime(
  current: number,
  total: number,
  format: Settings['progress_time_format'] | undefined,
  t: ReturnType<typeof translator>,
): string {
  if (format !== 'hours_minutes') return t('minutes_progress', { current, total });
  function duration(minutes: number) {
    if (minutes < 60) return t('duration_minutes', { minutes });
    const hours = t('duration_hours', { hours: Math.floor(minutes / 60) });
    const remainder = minutes % 60;
    return remainder ? `${hours} ${t('duration_minutes', { minutes: remainder })}` : hours;
  }
  return t('time_progress', { current: duration(current), total: duration(total) });
}

export function confirmedPercent(
  progress: Pick<Progress, 'confirmed_at' | 'confirmed_minutes' | 'required_minutes'> | null,
): number | null {
  const minutes = progress?.confirmed_minutes;
  if (
    !progress?.confirmed_at ||
    typeof minutes !== 'number' ||
    !Number.isFinite(minutes) ||
    !Number.isFinite(progress.required_minutes) ||
    progress.required_minutes <= 0
  )
    return null;
  return Math.floor(Math.min(1000, Math.max(0, (minutes * 1000) / progress.required_minutes))) / 10;
}
