import { renderHook, waitFor } from '@testing-library/react';
import useBackgroundResearch, {
  BACKGROUND_RESEARCH_STORAGE_KEY,
} from '../hooks/useBackgroundResearch';
import { appendEvidenceRows } from '../utils/evidenceStorage.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { fetchKalshiMarketClient } from '@/services/kalshi/kalshi.client.service';

jest.mock('@/services/kalshi/kalshi.client.service', () => ({
  fetchKalshiMarketClient: jest.fn(),
}));

jest.mock('../utils/evidenceStorage.utils', () => ({
  ...jest.requireActual('../utils/evidenceStorage.utils'),
  appendEvidenceRows: jest.fn(() => Promise.resolve()),
}));

const start = 1_800_000_000_000;
const deadline = start + 900_000;
const recorderId = 'test-recorder';
const quote = (time, price = 100_000) => ({ time, receivedAt: time, price });
const getEstimate = jest.fn(() => ({
  available: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  aboveProbability: 0.51,
  belowProbability: 0.49,
  direction: 'above',
  modelVersion: 'experimental-test-v1',
  pressure: { applied: true },
  learningFeatures: { featureVersion: 'test', values: [1, 2] },
  shadowPrediction: { aboveProbability: 0.53, modelVersion: 'shadow-test-v1' },
}));
beforeEach(() => {
  getEstimate.mockClear();
  appendEvidenceRows.mockClear();
  appendEvidenceRows.mockResolvedValue(undefined);
});

describe('shared browser recording', () => {
  let originalLocks;
  beforeEach(() => {
    localStorage.clear();
    originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: jest.fn(async (_, __, action) => action({ name: 'owned' })) },
    });
    jest.spyOn(Date, 'now').mockReturnValue(start + 180_000);
  });
  afterEach(() => {
    if (originalLocks) Object.defineProperty(navigator, 'locks', originalLocks);
    else delete navigator.locks;
    jest.restoreAllMocks();
  });
  const market = {
    ticker: 'KXBTC15M-TEST',
    eventTicker: 'KXBTC15M-TEST',
    seriesTicker: 'KXBTC15M',
    target: 100_000,
    startsAt: start,
    expiresAt: deadline,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
    status: 'active',
    receivedAt: start + 180_000,
  };
  const props = {
    isReady: true,
    now: start + 180_000,
    ticker: quote(start + 180_000),
    getEstimate,
    markets: [market],
  };

  test('persists target and exact pending evidence before append, then reloads without duplication', async () => {
    appendEvidenceRows.mockImplementationOnce(async (rows) => {
      const stored = JSON.parse(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY));
      expect(stored.state.markets[0].contract.target).toBe(100_000);
      expect(stored.pendingRows).toEqual(rows);
    });
    const first = renderHook((value) => useBackgroundResearch(value), { initialProps: props });
    await waitFor(() => expect(first.result.current.status.phase).toBe('analyzing'));
    const savedId = JSON.parse(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY)).recorderId;
    first.unmount();
    const second = renderHook((value) => useBackgroundResearch(value), { initialProps: props });
    await waitFor(() => expect(second.result.current.status.phase).toBe('analyzing'));
    expect(appendEvidenceRows).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY)).recorderId).toBe(
      savedId,
    );
  });

  test('retains pending evidence when append fails and replays the exact original rows', async () => {
    appendEvidenceRows.mockRejectedValueOnce(new Error('Storage temporarily unavailable.'));
    const { result, rerender } = renderHook((value) => useBackgroundResearch(value), {
      initialProps: props,
    });
    await waitFor(() => expect(result.current.warning).toBe('Storage temporarily unavailable.'));
    const original = JSON.parse(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY)).pendingRows;
    Date.now.mockReturnValue(start + 181_000);
    rerender({ ...props, now: start + 181_000, ticker: quote(start + 181_000, 120_000) });
    await waitFor(() => expect(result.current.warning).toBeNull());
    expect(appendEvidenceRows).toHaveBeenLastCalledWith(original);
    expect(
      JSON.parse(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY)).state.markets[0].contract
        .target,
    ).toBe(100_000);
  });

  test('does not append or create an independent target when another tab owns the lock', async () => {
    navigator.locks.request.mockImplementation(async (_, __, action) => action(null));
    renderHook(() => useBackgroundResearch(props));
    await waitFor(() => expect(navigator.locks.request).toHaveBeenCalled());
    expect(appendEvidenceRows).not.toHaveBeenCalled();
    expect(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY)).toBeNull();
  });

  test('pauses on unsupported coordination instead of risking multiple competing targets', async () => {
    delete navigator.locks;
    const { result } = renderHook(() => useBackgroundResearch(props));
    await waitFor(() => expect(result.current.warning).toContain('tab coordination'));
    expect(appendEvidenceRows).not.toHaveBeenCalled();
  });

  test('preserves corrupted storage and reports it instead of silently starting again', async () => {
    localStorage.setItem(BACKGROUND_RESEARCH_STORAGE_KEY, '{bad-json');
    const { result } = renderHook(() => useBackgroundResearch(props));
    await waitFor(() => expect(result.current.warning).not.toBeNull());
    expect(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY)).toBe('{bad-json');
    expect(appendEvidenceRows).not.toHaveBeenCalled();
  });

  test('does not silently reset an existing recorder whose state is missing', async () => {
    const saved = JSON.stringify({ recorderId, state: null, pendingRows: [] });
    localStorage.setItem(BACKGROUND_RESEARCH_STORAGE_KEY, saved);
    const { result } = renderHook(() => useBackgroundResearch(props));
    await waitFor(() => expect(result.current.warning).toContain('state is invalid'));
    expect(localStorage.getItem(BACKGROUND_RESEARCH_STORAGE_KEY)).toBe(saved);
    expect(appendEvidenceRows).not.toHaveBeenCalled();
  });

  test('a persistence failure prevents unanchored evidence from being appended', async () => {
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Storage is full.');
    });
    const { result } = renderHook(() => useBackgroundResearch(props));
    await waitFor(() => expect(result.current.warning).toBe('Storage is full.'));
    expect(appendEvidenceRows).not.toHaveBeenCalled();
  });

  test('Kalshi background research settles its saved contract independently of the selected market', async () => {
    const market = {
      ticker: 'KXBTC15M-SAVED',
      eventTicker: 'KXBTC15M-SAVED',
      seriesTicker: 'KXBTC15M',
      target: 99_500,
      startsAt: start,
      expiresAt: deadline,
      comparison: 'greater_or_equal',
      roundDigits: 2,
      rulesVerified: true,
      status: 'active',
      outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
      receivedAt: start + 180_000,
    };
    const kalshiProps = {
      ...props,
      outcomeDefinition: undefined,
      now: start + 180_000,
      ticker: quote(start + 180_000),
      markets: [market],
      getEstimate: () => ({ ...getEstimate(), outcomeDefinition: KALSHI_OUTCOME_DEFINITION }),
    };
    Date.now.mockReturnValue(start + 180_000);
    const { result, rerender } = renderHook((value) => useBackgroundResearch(value), {
      initialProps: kalshiProps,
    });
    await waitFor(() => expect(appendEvidenceRows).toHaveBeenCalledTimes(1));
    const captured = appendEvidenceRows.mock.calls[0][0][0];
    expect(captured.target).toBe(99_500);
    fetchKalshiMarketClient.mockResolvedValue({
      ...market,
      status: 'finalized',
      result: 'yes',
      settlementPrice: 99_500,
      receivedAt: deadline + 2000,
      settledAt: deadline + 1000,
    });
    Date.now.mockReturnValue(deadline + 2000);
    rerender({ ...kalshiProps, now: deadline + 2000, ticker: quote(deadline + 2000), markets: [] });
    await waitFor(() =>
      expect(fetchKalshiMarketClient).toHaveBeenCalledWith(market.ticker, expect.anything()),
    );
    await waitFor(() => expect(result.current.status.phase).toBe('settling'));
    Date.now.mockReturnValue(deadline + 3000);
    rerender({ ...kalshiProps, now: deadline + 3000, ticker: quote(deadline + 3000), markets: [] });
    await waitFor(() => expect(result.current.status.phase).toBe('waiting'));
    const rows = appendEvidenceRows.mock.calls.flatMap(([batch]) => batch);
    expect(
      rows.find((row) => row.event === 'outcome' && row.forecastId === captured.forecastId),
    ).toMatchObject({
      outcome: 'above',
      observedPrice: 99_500,
      outcomeStatus: 'observed',
      aboveProbability: captured.aboveProbability,
      kalshiOutcome: { result: 'yes', marketTicker: market.ticker },
    });
  });
});
