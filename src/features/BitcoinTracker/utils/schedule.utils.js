const minute = 60_000;

export function formatLocalDateTime(value) {
  if (!Number.isFinite(value)) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (number) => String(number).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function parseScheduledStart(value) {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(?:\.0{1,3})?)?$/.test(value)
  )
    return NaN;
  // Native datetime inputs can include a zero-millisecond suffix for whole seconds.
  const secondsValue = value.replace(/\.0{1,3}$/, '');
  const normalized = secondsValue.length === 16 ? `${secondsValue}:00` : secondsValue;
  const timestamp = new Date(normalized).getTime();
  // Reject invalid calendar dates and local times normalized across a DST gap.
  return formatLocalDateTime(timestamp) === normalized ? timestamp : NaN;
}

export function getScheduleError(startsAt, now) {
  if (!Number.isFinite(startsAt)) return 'Choose a valid local start date and time.';
  if (!Number.isFinite(now) || startsAt <= now) return 'Start time must be in the future.';
  if (startsAt > now + 24 * 60 * minute) return 'Choose a start within the next 24 hours.';
  return null;
}

export function getEndScheduleError(endsAt, now) {
  if (!Number.isFinite(endsAt)) return 'Choose a valid local end date and time.';
  if (!Number.isFinite(now) || endsAt <= now) return 'End time must be in the future.';
  if (endsAt > now + (24 * 60 + 15) * minute)
    return 'Choose an end within the next 24 hours and 15 minutes.';
  return null;
}

export function getNextQuarterHour(now) {
  return (Math.floor(now / (15 * minute)) + 1) * 15 * minute;
}
