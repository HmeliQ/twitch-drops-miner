import { expect, it } from 'vitest';
import { translator } from '../src/shared/lib/i18n';
import { formatProgressTime } from '../src/shared/lib/progress';

const t = translator({});

it.each([
  [0, 45, '0m / 45m'],
  [45, 60, '45m / 1h'],
  [60, 60, '1h / 1h'],
  [61, 90, '1h 1m / 1h 30m'],
  [330, 360, '5h 30m / 6h'],
  [1500, 1561, '25h / 26h 1m'],
  [0, 0, '0m / 0m'],
])('formats %i of %i minutes as %s', (current, total, expected) => {
  expect(formatProgressTime(current, total, 'hours_minutes', t)).toBe(expected);
});

it('preserves the original minutes format by default', () => {
  expect(formatProgressTime(330, 360, 'minutes', t)).toBe('330 / 360 min');
  expect(formatProgressTime(330, 360, undefined, t)).toBe('330 / 360 min');
});
