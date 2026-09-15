import { getKalshiContract } from './kalshi/contract.utils';
import { isKalshiCheckpointSelection, KALSHI_CHECKPOINT_MINUTES } from './fixedPrediction.utils';

export const CHECKPOINT_MINUTES = KALSHI_CHECKPOINT_MINUTES;
export const DEFAULT_FORECAST_PREFERENCES = Object.freeze({
  autoEnabled: false,
  checkpointMinutes: Object.freeze([9, 6]),
});
export const FORECAST_PREFERENCES_STORAGE_KEY = 'bitcoin-tracker:forecast-preferences:v1';
export const AUTOMATIC_FORECAST_STORAGE_KEY = 'bitcoin-tracker:automatic-forecast:v1';

const isTimestamp = (value) => Number.isSafeInteger(value) && value > 0;
const getDefaults = () => ({
  autoEnabled: DEFAULT_FORECAST_PREFERENCES.autoEnabled,
  checkpointMinutes: [...DEFAULT_FORECAST_PREFERENCES.checkpointMinutes],
});

export function getValidatedForecastPreferences(value) {
  if (
    !value ||
    typeof value.autoEnabled !== 'boolean' ||
    !isKalshiCheckpointSelection(value.checkpointMinutes)
  )
    return null;
  return {
    autoEnabled: value.autoEnabled,
    checkpointMinutes: CHECKPOINT_MINUTES.filter((minutes) =>
      value.checkpointMinutes.includes(minutes),
    ),
  };
}

export function readForecastPreferences(storage) {
  try {
    const saved = (storage ?? globalThis.localStorage).getItem(FORECAST_PREFERENCES_STORAGE_KEY);
    if (saved === null) return { preferences: getDefaults(), warning: null };
    const record = JSON.parse(saved);
    const preferences = record?.version === 1 ? getValidatedForecastPreferences(record) : null;
    if (!preferences) throw new Error('Invalid saved forecast preferences.');
    return { preferences, warning: null };
  } catch {
    return {
      preferences: getDefaults(),
      warning: 'Forecast preferences could not be restored. Automatic recording is off.',
    };
  }
}

export function writeForecastPreferences(value, storage) {
  const preferences = getValidatedForecastPreferences(value);
  if (!preferences) return 'Choose at least one supported fixed prediction time.';
  try {
    (storage ?? globalThis.localStorage).setItem(
      FORECAST_PREFERENCES_STORAGE_KEY,
      JSON.stringify({ version: 1, ...preferences }),
    );
    return null;
  } catch {
    return 'Forecast preferences could not be saved. Automatic recording is paused in this tab.';
  }
}

function getValidatedStartedEvent(value) {
  if (
    !value ||
    typeof value.marketTicker !== 'string' ||
    !/^KXBTC15M-[A-Z0-9-]{1,80}$/.test(value.marketTicker) ||
    !isTimestamp(value.startsAt) ||
    !isTimestamp(value.expiresAt) ||
    value.expiresAt - value.startsAt !== 900_000
  )
    return null;
  return {
    marketTicker: value.marketTicker,
    startsAt: value.startsAt,
    expiresAt: value.expiresAt,
  };
}

export function readAutomaticForecastMarker(storage) {
  try {
    const saved = (storage ?? globalThis.localStorage).getItem(AUTOMATIC_FORECAST_STORAGE_KEY);
    if (saved === null) return { lastStartedEvent: null, warning: null };
    const record = JSON.parse(saved);
    const lastStartedEvent =
      record?.version === 1 ? getValidatedStartedEvent(record.lastStartedEvent) : null;
    if (!lastStartedEvent) throw new Error('Invalid automatic event marker.');
    return { lastStartedEvent, warning: null };
  } catch {
    return {
      lastStartedEvent: null,
      warning: 'Automatic event history could not be read. Automatic recording is paused.',
    };
  }
}

export function writeAutomaticForecastMarker(contract, storage) {
  const lastStartedEvent = getValidatedStartedEvent({
    marketTicker: contract?.ticker,
    startsAt: contract?.startsAt,
    expiresAt: contract?.expiresAt,
  });
  if (!lastStartedEvent) return 'The automatic event identity is invalid.';
  const previous = readAutomaticForecastMarker(storage);
  if (previous.warning) return previous.warning;
  // One bounded watermark survives history clearing and prevents older boundaries from being
  // replayed after a clock rollback. The caller already owns the shared journal writer lock.
  if (previous.lastStartedEvent?.expiresAt >= lastStartedEvent.expiresAt) return null;
  try {
    (storage ?? globalThis.localStorage).setItem(
      AUTOMATIC_FORECAST_STORAGE_KEY,
      JSON.stringify({ version: 1, lastStartedEvent }),
    );
    return null;
  } catch {
    return 'The automatic event marker could not be saved. Automatic recording is paused.';
  }
}

/** A persisted automatic batch can repair a crash between the journal save and marker save. */
export function getLatestAutomaticForecastContract(forecasts = []) {
  return (
    forecasts
      .filter((forecast) => forecast.captureOrigin === 'automatic')
      .map((forecast) => getKalshiContract(forecast.kalshiMarket))
      .filter(Boolean)
      .sort((left, right) => right.expiresAt - left.expiresAt)[0] ?? null
  );
}

/** Choose one genuine open contract. Delayed settlement of a previous event never blocks it. */
export function getAutomaticKalshiEvent({
  markets = [],
  forecasts = [],
  scheduledForecast = null,
  now,
  lastStartedEvent = null,
} = {}) {
  if (!isTimestamp(now) || scheduledForecast?.status === 'scheduled') return null;
  const current = markets
    .filter((market) => ['active', 'open'].includes(market?.status))
    .map(getKalshiContract)
    .filter((contract) => contract && contract.startsAt <= now && contract.expiresAt > now)
    .sort(
      (left, right) => left.expiresAt - right.expiresAt || left.ticker.localeCompare(right.ticker),
    )[0];
  if (
    !current ||
    (lastStartedEvent && current.expiresAt <= lastStartedEvent.expiresAt) ||
    forecasts.some(
      (forecast) =>
        forecast.kalshiMarket?.ticker === current.ticker ||
        (['analyzing', 'pending'].includes(forecast.status) && forecast.expiresAt > now),
    )
  )
    return null;
  return current;
}
