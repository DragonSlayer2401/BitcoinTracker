import { KalshiDataError } from '../kalshi.validation';

export const BENCHMARK_HISTORY_HOUR_MS = 60 * 60_000;
const MAXIMUM_HISTORY_ROWS = 20_000;
const POSITIVE_DECIMAL = /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

export function validateBenchmarkHistoryRange({ hours, endingAt } = {}, now = Date.now()) {
  const currentHour = Math.floor(now / BENCHMARK_HISTORY_HOUR_MS) * BENCHMARK_HISTORY_HOUR_MS;
  const endsAt = endingAt === undefined ? currentHour : endingAt;
  if (
    ![2, 4].includes(hours) ||
    !Number.isSafeInteger(endsAt) ||
    endsAt <= 0 ||
    endsAt % BENCHMARK_HISTORY_HOUR_MS !== 0 ||
    ![currentHour, currentHour - BENCHMARK_HISTORY_HOUR_MS].includes(endsAt)
  ) {
    throw new KalshiDataError(
      'Select two or four hours ending at the current or previous UTC hour.',
      400,
    );
  }
  return { hours, startsAt: endsAt - hours * BENCHMARK_HISTORY_HOUR_MS, endsAt };
}

export function readBenchmarkHistoryQuery(request, now = Date.now()) {
  const parameters = new URL(request.url).searchParams;
  if (
    [...parameters.keys()].some((key) => !['hours', 'endingAt'].includes(key)) ||
    parameters.getAll('hours').length !== 1 ||
    parameters.getAll('endingAt').length > 1 ||
    !/^(2|4)$/.test(parameters.get('hours') ?? '') ||
    (parameters.has('endingAt') && !/^\d{13}$/.test(parameters.get('endingAt')))
  ) {
    throw new KalshiDataError('Invalid benchmark history range.', 400);
  }
  const range = validateBenchmarkHistoryRange(
    {
      hours: Number(parameters.get('hours')),
      endingAt: parameters.has('endingAt') ? Number(parameters.get('endingAt')) : undefined,
    },
    now,
  );
  return { hours: range.hours, endingAt: range.endsAt };
}

export function parseBenchmarkHistoryHour(response, startsAt) {
  const rows = response?.data?.payload;
  if (
    response?.data?.error ||
    !Number.isSafeInteger(startsAt) ||
    startsAt <= 0 ||
    startsAt % BENCHMARK_HISTORY_HOUR_MS !== 0 ||
    !Array.isArray(rows) ||
    rows.length > MAXIMUM_HISTORY_ROWS
  ) {
    throw new KalshiDataError('Kalshi returned invalid historical BRTI data.');
  }
  const byTime = new Map();
  for (const row of rows) {
    const time = row?.time;
    const price =
      typeof row?.value === 'string' && POSITIVE_DECIMAL.test(row.value) ? Number(row.value) : NaN;
    if (
      !Number.isSafeInteger(time) ||
      time < startsAt ||
      time >= startsAt + BENCHMARK_HISTORY_HOUR_MS ||
      !Number.isFinite(price) ||
      price <= 0 ||
      (byTime.has(time) && byTime.get(time) !== price)
    ) {
      throw new KalshiDataError('Kalshi returned invalid historical BRTI samples.');
    }
    // Validate every publication, including subsecond values, before selecting
    // exact second boundaries. Never invent a missing reading or candle extreme.
    byTime.set(time, price);
  }
  return [...byTime]
    .filter(([time]) => time % 1_000 === 0)
    .sort(([first], [second]) => first - second)
    .map(([time, price]) => ({ time, price }));
}
