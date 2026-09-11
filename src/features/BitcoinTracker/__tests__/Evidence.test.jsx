import { act, renderHook, waitFor } from '@testing-library/react';
import useForecastEvidence from '../hooks/useForecastEvidence';
import { appendEvidenceRows } from '../utils/evidenceStorage.utils';
import { getResearchForecast } from '../utils/researchForecast.utils';
import { KALSHI_OUTCOME_DEFINITION, getKalshiOutcome } from '../utils/kalshi/contract.utils';

jest.mock('../utils/evidenceStorage.utils', () => ({
  ...jest.requireActual('../utils/evidenceStorage.utils'),
  appendEvidenceRows: jest.fn(),
}));
jest.mock('../utils/researchForecast.utils', () => ({
  getResearchForecast: jest.fn(({ target, ticker }) => ({
    available: true,
    aboveProbability: ticker.price > target ? 0.7 : 0.3,
    belowProbability: ticker.price > target ? 0.3 : 0.7,
    lowerBound: 49000,
    upperBound: 51000,
  })),
}));
jest.mock('../utils/marketConditions.utils', () => ({
  getMarketConditions: jest.fn(({ target, ticker }) => ({
    features: { targetDistance: ticker.price - target },
    riskFlags: [],
    reason: null,
  })),
}));

const actualStorage = jest.requireActual('../utils/evidenceStorage.utils');
const NOW = Date.UTC(2026, 8, 9, 12, 0);
const END = NOW + 900_000;
const ticker = { price: 50000, time: NOW, receivedAt: NOW };
const contract = {
  ticker: 'KXBTC15M-26SEP091215-15',
  eventTicker: 'KXBTC15M-26SEP091215',
  seriesTicker: 'KXBTC15M',
  target: 49750,
  startsAt: NOW,
  expiresAt: END,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  rulesVerified: true,
  roundDigits: 2,
  comparison: 'greater_or_equal',
};
const entry = {
  kalshiMarket: contract,
  id: 'forecast-1',
  createdAt: NOW,
  startsAt: NOW,
  expiresAt: END,
  target: 49750,
  price: 50000,
  status: 'analyzing',
  aboveProbability: null,
  belowProbability: null,
  direction: 'neutral',
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  modelVersion: 'test-model',
  analysis: { policyVersion: 'test-policy' },
};
const proof = getKalshiOutcome(
  {
    ...contract,
    status: 'finalized',
    result: 'yes',
    settlementPrice: 50000,
    receivedAt: END + 1000,
    settledAt: END + 1000,
  },
  END + 1000,
);
const rows = () => appendEvidenceRows.mock.calls.flatMap(([batch]) => batch);
let currentTime = NOW;

async function recorder(initialForecasts = []) {
  let props = {
    forecasts: initialForecasts,
    candles: [],
    ticker,
    stream: {
      flow: {},
      liquidity: {},
      quality: {},
      getDeadlineOutcome: jest.fn(() => ({ status: 'waiting' })),
    },
    now: NOW,
    progress: null,
    isReady: true,
  };
  const view = renderHook((value) => useForecastEvidence(value), { initialProps: props });
  await act(async () => {});
  return {
    ...view,
    async update(patch, timestamp = patch.now ?? currentTime) {
      currentTime = timestamp;
      props = { ...props, ...patch };
      await act(async () => view.rerender(props));
    },
  };
}

describe('prospective forecast evidence', () => {
  test('exports the pressure calculation captured at the decision without reconstructing it later', () => {
    const pressure = {
      applied: true,
      expectedLogReturn: -0.0003,
      baselineAboveProbability: 0.6,
      unshiftedAboveProbability: 0.55,
      adjustmentPercentagePoints: -7,
      parameters: { pressureHalfLifeMinutes: 1 },
      components: { signedBtcPerMinute: -2, impactSampleCount: 12 },
    };
    const captured = {
      ...entry,
      createdAt: NOW + 180_000,
      status: 'pending',
      modelVersion: 'trade-pressure-log-return-v1',
      analysis: { policyVersion: 'pressure-snapshot-v3' },
      calculationMode: 'pressure-adjusted',
      aboveProbability: 0.48,
      belowProbability: 0.52,
    };
    const inputs = {
      entry: captured,
      now: NOW + 180_005,
      inputObservedAt: NOW + 180_000,
      ticker,
      estimate: { aboveProbability: 0.48, belowProbability: 0.52, pressure },
    };
    const decision = actualStorage.getEvidenceRow({ ...inputs, event: 'decision' });
    expect(decision).toMatchObject({
      modelVersion: captured.modelVersion,
      policyVersion: captured.analysis.policyVersion,
      calculationMode: 'pressure-adjusted',
      aboveProbability: 0.48,
      modelAboveProbability: 0.48,
      pressure,
    });
    expect(actualStorage.getEvidenceRow({ ...inputs, event: 'restored' })).toMatchObject({
      aboveProbability: 0.48,
      modelAboveProbability: null,
      pressure: null,
    });
  });

  beforeEach(() => {
    currentTime = NOW;
    jest.spyOn(Date, 'now').mockImplementation(() => currentTime);
    appendEvidenceRows.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  test('deduplicates five-second observations and uses each saved target rather than an editable draft', async () => {
    const view = await recorder();
    await view.update({ forecasts: [entry] });
    await view.update({ now: NOW + 1000, targetInput: '60000' });
    await view.update({ now: NOW + 5000, ticker: { ...ticker, price: 50100 } });
    expect(rows()).toHaveLength(2);
    expect(rows()[0]).toMatchObject({
      event: 'observation',
      sessionOrigin: 'new',
      target: 49750,
      inputObservedAt: NOW,
      featureCutoffAt: NOW,
      currentSide: 'above',
      intervalLow: 49000,
      intervalHigh: 51000,
      intervalCoverage: 0.8,
    });
    expect(rows()[1]).toMatchObject({
      target: 49750,
      spot: 50100,
      recordedAt: NOW + 5000,
      features: { targetDistance: 350 },
    });
    expect(getResearchForecast).toHaveBeenLastCalledWith(
      expect.objectContaining({ target: 49750 }),
      undefined,
      NOW,
    );
  });

  test('retains exact decision inputs despite a lagging display clock and a changed current ticker', async () => {
    const view = await recorder();
    await view.update({ forecasts: [entry] });
    const decisionAt = NOW + 180_750;
    const published = {
      ...entry,
      status: 'pending',
      createdAt: decisionAt,
      aboveProbability: 0.8,
      belowProbability: 0.2,
    };
    const decisionEvidence = {
      forecastId: entry.id,
      inputObservedAt: decisionAt,
      ticker: { ...ticker, price: 50200, time: decisionAt - 10, receivedAt: decisionAt },
      estimate: {
        aboveProbability: 0.8,
        belowProbability: 0.2,
        lowerBound: 49100,
        upperBound: 51100,
      },
      conditions: { features: { originalInput: true }, riskFlags: [] },
      stream: { flow: { captured: true }, liquidity: {}, quality: {} },
    };
    await view.update(
      {
        forecasts: [published],
        now: NOW + 180_000,
        ticker: { ...ticker, price: 48000 },
        progress: { decisionEvidence },
      },
      decisionAt + 5,
    );
    await view.update({ progress: null }, decisionAt + 10);
    const decision = rows().find((row) => row.event === 'decision');
    expect(decision).toMatchObject({
      inputObservedAt: decisionAt,
      featureCutoffAt: decisionAt,
      recordedAt: decisionAt + 5,
      spot: 50200,
      intervalLow: 49100,
      features: { originalInput: true },
      tradeFlow: { captured: true },
    });
    expect(rows().filter((row) => row.event === 'decision')).toHaveLength(1);
  });

  test('uses actual observation receipt time when a stream render occurs between clock ticks', async () => {
    const view = await recorder();
    await view.update(
      { forecasts: [entry], ticker: { ...ticker, time: NOW + 600, receivedAt: NOW + 650 } },
      NOW + 700,
    );
    expect(rows()[0]).toMatchObject({
      recordedAt: NOW + 700,
      inputObservedAt: NOW + 700,
      featureCutoffAt: NOW + 700,
      receivedAt: NOW + 650,
    });
  });

  test('restored fixed decisions never acquire current features or a fabricated new capture', async () => {
    const published = {
      ...entry,
      status: 'pending',
      createdAt: NOW - 1000,
      aboveProbability: 0.7,
      belowProbability: 0.3,
    };
    const view = await recorder([published]);
    await view.update({ now: NOW + 5000, ticker: { ...ticker, price: 60000 } });
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      event: 'restored',
      sessionOrigin: 'restored',
      inputStatus: 'restored-without-inputs',
      inputObservedAt: null,
      featureCutoffAt: null,
      spot: null,
      features: null,
      intervalLow: null,
      capturedAt: NOW - 1000,
    });
  });

  test('restored analysis records only newly seen observations, never earlier sample times', async () => {
    currentTime = NOW + 120_000;
    const view = await recorder([entry]);
    expect(rows().map((row) => row.event)).toEqual(['restored', 'observation']);
    const observation = rows().find((row) => row.event === 'observation');
    expect(observation).toMatchObject({
      sessionOrigin: 'restored',
      recordedAt: NOW + 120_000,
      inputObservedAt: NOW + 120_000,
    });
    await view.update({ now: NOW + 125_000 });
    expect(rows().filter((row) => row.event === 'observation')).toHaveLength(2);
  });

  test('records a no-call outcome after the user clears it and starts another window', async () => {
    const view = await recorder();
    await view.update({ forecasts: [entry] });
    const withheld = { ...entry, status: 'withheld', withholdingReason: 'no-consensus' };
    await view.update({ forecasts: [withheld], now: NOW + 300_000 });
    await view.update({ forecasts: [], now: NOW + 400_000 });
    const next = {
      ...entry,
      id: 'next',
      startsAt: NOW + 400_000,
      createdAt: NOW + 400_000,
      expiresAt: END + 400_000,
      target: 51000,
    };
    await view.update({
      forecasts: [next],
      now: END + 1000,
      kalshiOutcomes: [proof],
    });
    const outcome = rows().find((row) => row.event === 'outcome');
    expect(outcome).toMatchObject({
      forecastId: entry.id,
      decision: 'withheld',
      outcomeStatus: 'observed',
      outcome: 'above',
      target: 49750,
      observedPrice: 50000,
      kalshiOutcome: proof,
      features: null,
      inputObservedAt: null,
    });
    await view.update({ now: END + 2000 });
    expect(rows().filter((row) => row.event === 'outcome')).toHaveLength(1);
  });

  test('withheld outcomes wait for official settlement instead of timing out', async () => {
    const view = await recorder([{ ...entry, status: 'withheld' }]);
    await view.update({ now: END + 1000, kalshiOutcomes: [{ ...proof, observedAt: END + 1 }] });
    expect(rows().some((row) => row.event === 'outcome')).toBe(false);
    await view.update({ now: END + 60_000 });
    expect(rows().some((row) => row.event === 'outcome')).toBe(false);
    await view.update({ now: END + 61_000, kalshiOutcomes: [proof] });
    expect(rows().find((row) => row.event === 'outcome')).toMatchObject({
      outcomeStatus: 'observed',
      kalshiOutcome: proof,
    });
  });

  test('outcome rows contain endpoint proof without passing current data off as decision inputs', async () => {
    const pending = { ...entry, status: 'pending', aboveProbability: 0.7, belowProbability: 0.3 };
    const view = await recorder([pending]);
    await view.update({
      forecasts: [{ ...pending, ...proof, status: 'resolved', outcome: 'above' }],
      now: END + 1000,
    });
    expect(rows().find((row) => row.event === 'outcome')).toMatchObject({
      inputStatus: 'outcome-only',
      quoteTime: null,
      spot: null,
      features: null,
      tradeFlow: null,
      intervalLow: null,
      observedPrice: proof.observedPrice,
      aboveProbability: 0.7,
    });
  });

  test('pauses queued and future writes after storage failure', async () => {
    let rejectWrite;
    appendEvidenceRows.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectWrite = reject;
        }),
    );
    const view = await recorder();
    await view.update({ forecasts: [entry] });
    await view.update({ now: NOW + 5000 });
    expect(appendEvidenceRows).toHaveBeenCalledTimes(1);
    await act(async () => rejectWrite(new Error('Storage quota reached.')));
    await waitFor(() => expect(view.result.current).toBe('Storage quota reached.'));
    await view.update({ now: NOW + 10_000 });
    expect(appendEvidenceRows).toHaveBeenCalledTimes(1);
  });
});

function fakeDatabase({ rows: initialRows = [], count } = {}) {
  const saved = new Map(initialRows.map((row) => [row.eventId, row]));
  const database = {
    close: jest.fn(),
    transaction: () => {
      const transaction = {};
      let pending = 0;
      let completed = false;
      const request = (getValue) => {
        const operation = {};
        pending += 1;
        Promise.resolve().then(() => {
          operation.result = getValue();
          operation.onsuccess?.();
          pending -= 1;
          Promise.resolve().then(() => {
            if (!pending && !completed) {
              completed = true;
              transaction.oncomplete?.();
            }
          });
        });
        return operation;
      };
      transaction.objectStore = () => ({
        count: () => request(() => count ?? saved.size),
        getKey: (key) => request(() => (saved.has(key) ? key : undefined)),
        add: (row) =>
          request(() => {
            saved.set(row.eventId, JSON.parse(JSON.stringify(row)));
            return row.eventId;
          }),
        index: () => ({
          getAll: () =>
            request(() => [...saved.values()].sort((a, b) => a.recordedAt - b.recordedAt)),
        }),
      });
      return transaction;
    },
  };
  const requests = [];
  const indexedDB = {
    open: jest.fn(() => {
      const request = { result: database };
      requests.push(request);
      Promise.resolve().then(() => request.onsuccess?.());
      return request;
    }),
  };
  return { database, saved, indexedDB, requests };
}

describe('append-only research storage', () => {
  const original = globalThis.indexedDB;
  afterEach(() => {
    globalThis.indexedDB = original;
  });

  test('deduplicates without overwriting and exports chronological rows', async () => {
    const first = { eventId: 'one', recordedAt: NOW, spot: 50000 };
    const second = { eventId: 'two', recordedAt: NOW + 1000, spot: 50100 };
    const harness = fakeDatabase();
    globalThis.indexedDB = harness.indexedDB;
    await actualStorage.appendEvidenceRows([second, first, { ...first, spot: 999 }]);
    await actualStorage.appendEvidenceRows([{ ...first, spot: 1 }]);
    expect(await actualStorage.readEvidenceRows()).toEqual([first, second]);
    expect(harness.database.close).toHaveBeenCalledTimes(3);
  });

  test('accepts duplicate retries at the row cap but refuses new rows without deleting old data', async () => {
    const existing = { eventId: 'one', recordedAt: NOW };
    const harness = fakeDatabase({ rows: [existing], count: 25000 });
    globalThis.indexedDB = harness.indexedDB;
    await expect(actualStorage.appendEvidenceRows([existing])).resolves.toBeUndefined();
    await expect(
      actualStorage.appendEvidenceRows([{ eventId: 'new', recordedAt: NOW }]),
    ).rejects.toThrow('full');
    expect([...harness.saved.values()]).toEqual([existing]);
  });

  test('closes a database that opens after its blocked request was rejected', async () => {
    let request;
    const database = { close: jest.fn() };
    globalThis.indexedDB = {
      open: () => {
        request = { result: database };
        Promise.resolve().then(() => request.onblocked());
        return request;
      },
    };
    await expect(actualStorage.readEvidenceRows()).rejects.toThrow('blocking');
    request.onsuccess();
    expect(database.close).toHaveBeenCalledTimes(1);
  });

  test('reports unavailable storage and rejects malformed events', async () => {
    globalThis.indexedDB = undefined;
    await expect(actualStorage.readEvidenceRows()).rejects.toThrow('unavailable');
    await expect(
      actualStorage.appendEvidenceRows([{ eventId: '', recordedAt: NaN }]),
    ).rejects.toThrow('invalid');
  });
});
