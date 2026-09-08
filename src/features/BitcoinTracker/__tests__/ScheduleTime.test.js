import {
  formatLocalDateTime,
  getEndScheduleError,
  getNextQuarterHour,
  getScheduleError,
  parseScheduledStart,
} from '../utils/schedule.utils';

const MINUTE = 60_000;
const NOW = new Date(2026, 8, 7, 12, 3, 9).getTime();

describe('scheduled local start time', () => {
  test('formats and parses a local date without losing its seconds or changing its timezone', () => {
    expect(formatLocalDateTime(NOW)).toBe('2026-09-07T12:03:09');
    expect(parseScheduledStart(formatLocalDateTime(NOW))).toBe(NOW);
  });

  test('accepts a minute-only local input with zero seconds', () => {
    const timestamp = parseScheduledStart('2026-09-07T12:03');

    expect(timestamp).toBe(new Date(2026, 8, 7, 12, 3, 0).getTime());
    expect(formatLocalDateTime(timestamp)).toBe('2026-09-07T12:03:00');
  });

  test.each(['.0', '.00', '.000'])(
    'accepts a native input zero-millisecond suffix %s without losing whole seconds',
    (suffix) => {
      const timestamp = parseScheduledStart(`2026-09-07T12:03:09${suffix}`);

      expect(timestamp).toBe(NOW);
      expect(formatLocalDateTime(timestamp)).toBe('2026-09-07T12:03:09');
      expect(parseScheduledStart(`2026-09-07T12:00:00${suffix}`)).toBe(
        new Date(2026, 8, 7, 12, 0, 0).getTime(),
      );
    },
  );

  test('accepts a valid leap day and zero-pads local fields', () => {
    const timestamp = parseScheduledStart('2028-02-29T01:02:03');

    expect(timestamp).toBe(new Date(2028, 1, 29, 1, 2, 3).getTime());
    expect(formatLocalDateTime(timestamp)).toBe('2028-02-29T01:02:03');
  });

  test.each([NaN, Infinity, -Infinity, undefined, null, '2026-09-07', 8.64e15 + 1])(
    'formats an invalid timestamp as an empty value: %s',
    (value) => {
      expect(formatLocalDateTime(value)).toBe('');
    },
  );

  test.each([
    '',
    null,
    undefined,
    NOW,
    '2026-02-29T12:00',
    '2026-02-30T12:00',
    '2026-04-31T12:00',
    '2026-00-07T12:00',
    '2026-13-07T12:00',
    '2026-09-00T12:00',
    '2026-09-32T12:00',
    '2026-09-07T24:00',
    '2026-09-07T12:60',
    '2026-09-07T12:00:60',
    '2026-9-7T12:00',
    '2026-09-07',
    '2026-09-07 12:00',
    '2026-09-07T12:00Z',
    '2026-09-07T12:00:00.001',
    '2026-09-07T12:00:00.01',
    '2026-09-07T12:00:00.1',
    '2026-09-07T12:00:00-05:00',
    ' 2026-09-07T12:00',
    '2026-09-07T12:00 ',
  ])('rejects invalid dates and non-local or malformed inputs: %s', (value) => {
    expect(parseScheduledStart(value)).toBeNaN();
  });
});

describe('schedule timing limits', () => {
  test.each([NaN, Infinity, -Infinity, null, undefined, '123'])(
    'rejects invalid start timestamps without coercion: %s',
    (startsAt) => {
      expect(getScheduleError(startsAt, NOW)).toMatch(/valid local start date and time/);
    },
  );

  test.each([NaN, Infinity, null, undefined, '123'])(
    'rejects an invalid current timestamp: %s',
    (now) => {
      expect(getScheduleError(NOW + MINUTE, now)).toMatch(/future/);
    },
  );

  test('requires a future start and accepts up to exactly 24 hours from now', () => {
    expect(getScheduleError(NOW - 1, NOW)).toMatch(/future/);
    expect(getScheduleError(NOW, NOW)).toMatch(/future/);
    expect(getScheduleError(NOW + 1, NOW)).toBeNull();
    expect(getScheduleError(NOW + 24 * 60 * MINUTE, NOW)).toBeNull();
    expect(getScheduleError(NOW + 24 * 60 * MINUTE + 1, NOW)).toMatch(/next 24 hours/);
  });

  test('chooses the next quarter hour strictly after the current time', () => {
    const quarterHour = Date.UTC(2026, 8, 7, 12, 15);

    expect(getNextQuarterHour(quarterHour - 1)).toBe(quarterHour);
    expect(getNextQuarterHour(quarterHour - 12 * MINUTE)).toBe(quarterHour);
    expect(getNextQuarterHour(quarterHour)).toBe(quarterHour + 15 * MINUTE);
    expect(getNextQuarterHour(quarterHour + 1)).toBe(quarterHour + 15 * MINUTE);
  });

  test('advances the quarter-hour shortcut across midnight', () => {
    const beforeMidnight = Date.UTC(2026, 8, 7, 23, 59, 59);

    expect(getNextQuarterHour(beforeMidnight)).toBe(Date.UTC(2026, 8, 8, 0, 0));
  });
});

describe('scheduled end time limits', () => {
  test.each([NaN, Infinity, -Infinity, null, undefined, '123'])(
    'rejects invalid end timestamps without coercion: %s',
    (endsAt) => {
      expect(getEndScheduleError(endsAt, NOW)).toMatch(/valid local end date and time/);
    },
  );

  test.each([NaN, Infinity, -Infinity, null, undefined, '123'])(
    'rejects an invalid current timestamp for an end-based window: %s',
    (now) => {
      expect(getEndScheduleError(NOW + 12 * MINUTE, now)).toMatch(/in the future/);
    },
  );

  test('accepts any future end, including a window that has already started', () => {
    expect(getEndScheduleError(NOW - 1, NOW)).toMatch(/in the future/);
    expect(getEndScheduleError(NOW, NOW)).toMatch(/in the future/);
    expect(getEndScheduleError(NOW + 1, NOW)).toBeNull();
    expect(getEndScheduleError(NOW + 12 * MINUTE, NOW)).toBeNull();
    expect(getEndScheduleError(NOW + 15 * MINUTE, NOW)).toBeNull();
    expect(getEndScheduleError(NOW + 15 * MINUTE + 1, NOW)).toBeNull();
  });

  test('accepts a derived start up to exactly twenty-four hours away', () => {
    const maximumEnd = NOW + (24 * 60 + 15) * MINUTE;

    expect(getEndScheduleError(maximumEnd, NOW)).toBeNull();
    expect(getEndScheduleError(maximumEnd + 1, NOW)).toMatch(/24 hours and 15 minutes/);
    expect(getScheduleError(maximumEnd - 15 * MINUTE, NOW)).toBeNull();
  });

  test('accepts a window whose end is on the next local calendar day', () => {
    const now = new Date(2026, 8, 7, 23, 45).getTime();
    const end = parseScheduledStart('2026-09-08T00:05:00');

    expect(getEndScheduleError(end, now)).toBeNull();
    expect(formatLocalDateTime(end - 15 * MINUTE)).toBe('2026-09-07T23:50:00');
  });

  test.each([
    ['fall back', Date.UTC(2026, 10, 1, 6, 55), Date.UTC(2026, 10, 1, 7, 15)],
    ['spring forward', Date.UTC(2026, 2, 8, 7, 55), Date.UTC(2026, 2, 8, 8, 15)],
  ])('uses elapsed time across the Chicago %s transition', (_transition, now, end) => {
    expect(getEndScheduleError(end, now)).toBeNull();
    expect(end - 15 * MINUTE - now).toBe(5 * MINUTE);
    expect(getEndScheduleError(end - 5 * MINUTE, now)).toBeNull();
    expect(getEndScheduleError(end - 19 * MINUTE, now)).toBeNull();
  });
});
