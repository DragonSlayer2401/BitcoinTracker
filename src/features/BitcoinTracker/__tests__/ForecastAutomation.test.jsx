import { StrictMode } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import useForecastPreferences from '../hooks/useForecastPreferences';
import useAutomaticKalshiForecast from '../hooks/useAutomaticKalshiForecast';
import {
  AUTOMATIC_FORECAST_STORAGE_KEY,
  FORECAST_PREFERENCES_STORAGE_KEY,
  getAutomaticKalshiEvent,
  getValidatedForecastPreferences,
  readAutomaticForecastMarker,
  readForecastPreferences,
  writeAutomaticForecastMarker,
  writeForecastPreferences,
} from '../utils/forecastAutomation.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

const START = Date.UTC(2026, 8, 14, 12);
const END = START + 900_000;
const MARKET = {
  ticker: 'KXBTC15M-26SEP141215-15',
  eventTicker: 'KXBTC15M-26SEP141215',
  seriesTicker: 'KXBTC15M',
  startsAt: START,
  expiresAt: END,
  target: 50_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  status: 'active',
};
const NEXT_MARKET = {
  ...MARKET,
  ticker: 'KXBTC15M-26SEP141230-30',
  eventTicker: 'KXBTC15M-26SEP141230',
  startsAt: END,
  expiresAt: END + 900_000,
};

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('Fixed checkpoint preferences', () => {
  test('starts off with 9 and 6 minutes and normalizes supported selections', () => {
    expect(readForecastPreferences()).toEqual({
      preferences: { autoEnabled: false, checkpointMinutes: [9, 6] },
      warning: null,
    });
    expect(
      getValidatedForecastPreferences({ autoEnabled: true, checkpointMinutes: [1, 12, 6] }),
    ).toEqual({
      autoEnabled: true,
      checkpointMinutes: [12, 6, 1],
    });
    for (const checkpointMinutes of [[], [9, 9], [15], ['9'], null]) {
      expect(getValidatedForecastPreferences({ autoEnabled: false, checkpointMinutes })).toBeNull();
    }
  });

  test('persists settings, restores on reload and prevents clearing the last checkpoint', () => {
    const first = renderHook(() => useForecastPreferences());
    expect(first.result.current.isRestored).toBe(true);
    act(() => first.result.current.setCheckpointMinutes([12, 3]));
    act(() => first.result.current.setAutoEnabled(true));
    expect(first.result.current.preferences).toEqual({
      autoEnabled: true,
      checkpointMinutes: [12, 3],
    });
    act(() => first.result.current.setCheckpointMinutes([]));
    expect(first.result.current.preferences.checkpointMinutes).toEqual([12, 3]);
    expect(first.result.current.warning).toMatch(/at least one/);
    first.unmount();
    const second = renderHook(() => useForecastPreferences());
    expect(second.result.current.preferences).toEqual({
      autoEnabled: true,
      checkpointMinutes: [12, 3],
    });
    expect(second.result.current.warning).toBeNull();
  });

  test('synchronizes other-tab changes and merges setters against latest saved values', () => {
    const view = renderHook(() => useForecastPreferences());
    writeForecastPreferences({ autoEnabled: false, checkpointMinutes: [6, 1] });
    // A user action can precede delivery of the other tab's storage event.
    act(() => view.result.current.setAutoEnabled(true));
    expect(view.result.current.preferences).toEqual({
      autoEnabled: true,
      checkpointMinutes: [6, 1],
    });
    act(() => {
      writeForecastPreferences({ autoEnabled: false, checkpointMinutes: [9] });
      window.dispatchEvent(new StorageEvent('storage', { key: FORECAST_PREFERENCES_STORAGE_KEY }));
    });
    expect(view.result.current.preferences).toEqual({ autoEnabled: false, checkpointMinutes: [9] });
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent('storage', { key: null }));
    });
    expect(view.result.current.preferences).toEqual({
      autoEnabled: false,
      checkpointMinutes: [9, 6],
    });
  });

  test('keeps automation off when saved settings are invalid or a preference write fails', () => {
    localStorage.setItem(FORECAST_PREFERENCES_STORAGE_KEY, '{invalid');
    const view = renderHook(() => useForecastPreferences());
    expect(view.result.current.preferences.autoEnabled).toBe(false);
    expect(view.result.current.warning).toMatch(/could not be restored/);
    localStorage.removeItem(FORECAST_PREFERENCES_STORAGE_KEY);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    act(() => view.result.current.setAutoEnabled(true));
    expect(view.result.current.preferences.autoEnabled).toBe(false);
    expect(view.result.current.warning).toMatch(/could not be saved/);
  });
});

describe('Automatic Kalshi event selection', () => {
  test('uses verified open contract boundaries and waits for an official target', () => {
    expect(getAutomaticKalshiEvent({ markets: [MARKET], now: START - 1 })).toBeNull();
    expect(getAutomaticKalshiEvent({ markets: [MARKET], now: START })?.ticker).toBe(MARKET.ticker);
    expect(getAutomaticKalshiEvent({ markets: [MARKET], now: END })).toBeNull();
    expect(getAutomaticKalshiEvent({ markets: [MARKET, NEXT_MARKET], now: END })?.ticker).toBe(
      NEXT_MARKET.ticker,
    );
    for (const market of [
      { ...MARKET, target: null },
      { ...MARKET, rulesVerified: false },
      { ...MARKET, status: 'initialized' },
    ]) {
      expect(getAutomaticKalshiEvent({ markets: [market], now: START })).toBeNull();
    }
  });

  test('does not repeat recorded contracts or interrupt manual/scheduled work', () => {
    const args = { markets: [MARKET], now: START + 1000 };
    expect(
      getAutomaticKalshiEvent({
        ...args,
        forecasts: [{ kalshiMarket: MARKET, status: 'withheld' }],
      }),
    ).toBeNull();
    expect(
      getAutomaticKalshiEvent({ ...args, forecasts: [{ status: 'pending', expiresAt: END }] }),
    ).toBeNull();
    expect(
      getAutomaticKalshiEvent({ ...args, scheduledForecast: { status: 'scheduled' } }),
    ).toBeNull();
    expect(
      getAutomaticKalshiEvent({
        ...args,
        forecasts: [{ status: 'awaiting-settlement', expiresAt: START }],
      })?.ticker,
    ).toBe(MARKET.ticker);
  });

  test('keeps a bounded watermark through history clearing and clock rollback', () => {
    expect(writeAutomaticForecastMarker(MARKET)).toBeNull();
    const marker = readAutomaticForecastMarker().lastStartedEvent;
    expect(
      getAutomaticKalshiEvent({
        markets: [MARKET],
        now: START + 1000,
        forecasts: [],
        lastStartedEvent: marker,
      }),
    ).toBeNull();
    expect(writeAutomaticForecastMarker(NEXT_MARKET)).toBeNull();
    expect(writeAutomaticForecastMarker(MARKET)).toBeNull();
    expect(readAutomaticForecastMarker().lastStartedEvent.marketTicker).toBe(NEXT_MARKET.ticker);
  });
});

describe('Automatic event coordination for the journal owner', () => {
  const props = (overrides = {}) => ({
    enabled: true,
    isReady: true,
    markets: [MARKET, NEXT_MARKET],
    forecasts: [],
    scheduledForecast: null,
    now: START,
    onStartEvent: jest.fn(() => true),
    ...overrides,
  });

  test('records once through StrictMode, rerender, reload and clearing visible history', () => {
    const values = props();
    const first = renderHook((value) => useAutomaticKalshiForecast(value), {
      initialProps: values,
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });
    expect(values.onStartEvent).toHaveBeenCalledTimes(1);
    first.rerender({ ...values, now: START + 1000, forecasts: [] });
    expect(values.onStartEvent).toHaveBeenCalledTimes(1);
    first.unmount();
    renderHook(() => useAutomaticKalshiForecast({ ...values, now: START + 2000 }));
    expect(values.onStartEvent).toHaveBeenCalledTimes(1);
  });

  test('starts the next event while prior fixed calls await settlement, and stops when disabled', () => {
    const values = props();
    const view = renderHook((value) => useAutomaticKalshiForecast(value), { initialProps: values });
    view.rerender({
      ...values,
      now: END,
      forecasts: [{ kalshiMarket: MARKET, expiresAt: END, status: 'awaiting-settlement' }],
    });
    expect(values.onStartEvent).toHaveBeenCalledTimes(2);
    expect(values.onStartEvent.mock.calls[1][0].ticker).toBe(NEXT_MARKET.ticker);
    view.rerender({ ...values, enabled: false, now: END + 1000 });
    expect(values.onStartEvent).toHaveBeenCalledTimes(2);
  });

  test('waits for ownership and does not retry another owner’s completed event', () => {
    const values = props({ isReady: false });
    const view = renderHook((value) => useAutomaticKalshiForecast(value), { initialProps: values });
    expect(values.onStartEvent).not.toHaveBeenCalled();
    writeAutomaticForecastMarker(MARKET);
    view.rerender({ ...values, isReady: true });
    expect(values.onStartEvent).not.toHaveBeenCalled();
  });

  test('a declined start is retried without prematurely marking the event complete', () => {
    const values = props({
      onStartEvent: jest.fn().mockReturnValueOnce(false).mockReturnValue(true),
    });
    const view = renderHook((value) => useAutomaticKalshiForecast(value), { initialProps: values });
    expect(readAutomaticForecastMarker().lastStartedEvent).toBeNull();
    view.rerender({ ...values, now: START + 1000 });
    expect(values.onStartEvent).toHaveBeenCalledTimes(2);
    expect(readAutomaticForecastMarker().lastStartedEvent.marketTicker).toBe(MARKET.ticker);
  });

  test('a restored journal deduplicates a crash after batch persistence but before the marker', () => {
    const values = props({
      forecasts: [
        { kalshiMarket: MARKET, expiresAt: END, status: 'analyzing', captureOrigin: 'automatic' },
      ],
    });
    const view = renderHook((value) => useAutomaticKalshiForecast(value), { initialProps: values });
    expect(values.onStartEvent).not.toHaveBeenCalled();
    expect(readAutomaticForecastMarker().lastStartedEvent.marketTicker).toBe(MARKET.ticker);
    view.rerender({ ...values, forecasts: [], now: START + 1000 });
    expect(values.onStartEvent).not.toHaveBeenCalled();
  });

  test('pauses on invalid history before starting, or failed marker persistence after one start', () => {
    localStorage.setItem(AUTOMATIC_FORECAST_STORAGE_KEY, '{}');
    const values = props();
    const invalid = renderHook(() => useAutomaticKalshiForecast(values));
    expect(values.onStartEvent).not.toHaveBeenCalled();
    expect(invalid.result.current.warning).toMatch(/could not be read/);
    invalid.unmount();
    localStorage.removeItem(AUTOMATIC_FORECAST_STORAGE_KEY);
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    const failed = renderHook((value) => useAutomaticKalshiForecast(value), {
      initialProps: values,
    });
    expect(values.onStartEvent).toHaveBeenCalledTimes(1);
    expect(failed.result.current.warning).toMatch(/could not be saved/);
    failed.rerender({ ...values, now: END });
    expect(values.onStartEvent).toHaveBeenCalledTimes(1);
  });
});
