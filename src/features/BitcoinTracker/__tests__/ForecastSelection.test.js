import { selectActiveForecast, selectLatestForecast } from '../state/selectors/trackerSelectors';

const START = Date.UTC(2026, 8, 14, 12);
const END = START + 900_000;
const stateFor = (forecasts) => ({ tracker: { forecasts, scheduledForecast: null } });
const checkpoint = (minutes, overrides = {}) => ({
  id: `current-${minutes}`,
  checkpointMinutes: minutes,
  startsAt: START,
  expiresAt: END,
  createdAt: END - minutes * 60_000,
  kalshiMarket: { ticker: 'KXBTC15M-CURRENT' },
  status: 'pending',
  aboveProbability: 0.7,
  belowProbability: 0.3,
  analysis: { earliestAt: END - minutes * 60_000 },
  ...overrides,
});

test('a later saved call remains primary when the first checkpoint missed and the event closes', () => {
  const missed = checkpoint(12, {
    status: 'withheld',
    aboveProbability: null,
    belowProbability: null,
  });
  const nine = checkpoint(9);
  const six = checkpoint(6);
  const pending = stateFor([missed, nine, six]);
  expect(selectActiveForecast(pending)).toBe(six);
  expect(selectLatestForecast(pending)).toBe(six);

  const awaiting = [missed, nine, six].map((forecast) =>
    forecast.status === 'pending' ? { ...forecast, status: 'awaiting-settlement' } : forecast,
  );
  const closed = stateFor(awaiting);
  expect(selectActiveForecast(closed)).toBeNull();
  expect(selectLatestForecast(closed)).toBe(awaiting[2]);
  expect(awaiting.map((forecast) => forecast.id)).toEqual(['current-12', 'current-9', 'current-6']);
});

test('the next analyzing checkpoint stays active alongside the previously published call', () => {
  const nine = checkpoint(9);
  const six = checkpoint(6, {
    status: 'analyzing',
    createdAt: START,
    aboveProbability: null,
    belowProbability: null,
  });
  const three = checkpoint(3, {
    status: 'analyzing',
    createdAt: START,
    aboveProbability: null,
    belowProbability: null,
  });
  const state = stateFor([three, nine, six]);
  expect(selectActiveForecast(state)).toBe(six);
  expect(selectLatestForecast(state)).toBe(nine);
});

test('a newer event without a published call does not display a prior event as its saved result', () => {
  const prior = checkpoint(6, { status: 'resolved' });
  const newer = checkpoint(9, {
    id: 'next-9',
    startsAt: END,
    expiresAt: END + 900_000,
    createdAt: END + 360_000,
    kalshiMarket: { ticker: 'KXBTC15M-NEXT' },
    status: 'withheld',
    aboveProbability: null,
    belowProbability: null,
  });
  expect(selectLatestForecast(stateFor([prior, newer]))).toBe(newer);
});

test('an empty journal has no active or latest forecast', () => {
  const state = stateFor([]);
  expect(selectActiveForecast(state)).toBeNull();
  expect(selectLatestForecast(state)).toBeNull();
});
