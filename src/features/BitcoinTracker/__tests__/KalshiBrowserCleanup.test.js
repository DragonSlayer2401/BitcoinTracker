/** @jest-environment node */
import { IDBFactory } from 'fake-indexeddb';
import { cleanupLegacyBrowserResearch } from '../utils/kalshi/browserCleanup.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { KALSHI_MODEL_VERSION } from '../utils/kalshi/forecast.utils';
import { getFixedForecastAnalysis, KALSHI_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { appendEvidenceRows, openEvidenceDatabase } from '../utils/evidenceStorage.utils';
import { queueForecastSnapshots, readResearchOutbox } from '../utils/researchOutbox.utils';

const JOURNAL = 'bitcoin-tracker:journal:v1';
const START = Date.UTC(2026, 8, 10, 12);
const END = START + 900_000;
const legacy = {
  id: 'legacy',
  status: 'pending',
  outcomeDefinition: 'coinbase-last-trade-at-deadline-v1',
};
const market = {
  ticker: 'KXBTC15M-26SEP101215-15',
  eventTicker: 'KXBTC15M-26SEP101215',
  seriesTicker: 'KXBTC15M',
  target: 50_000,
  startsAt: START,
  expiresAt: END,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
};
const kalshi = {
  id: 'kalshi',
  createdAt: START,
  startsAt: START,
  expiresAt: END,
  timingMode: 'end',
  price: 50_000,
  target: 50_000,
  aboveProbability: null,
  belowProbability: null,
  direction: 'neutral',
  modelVersion: KALSHI_MODEL_VERSION,
  status: 'analyzing',
  calculationMode: null,
  analysis: getFixedForecastAnalysis({
    startedAt: START,
    expiresAt: END,
    policyVersion: KALSHI_POLICY_VERSION,
  }),
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  kalshiMarket: market,
  kalshi: null,
};
const scheduled = {
  id: 'armed',
  createdAt: START - 60_000,
  startsAt: START,
  expiresAt: END,
  target: null,
  status: 'scheduled',
  marketTicker: market.ticker,
  eventTicker: market.eventTicker,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  policyVersion: KALSHI_POLICY_VERSION,
};

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: jest.fn((key) => values.get(key) ?? null),
    setItem: jest.fn((key, value) => values.set(key, value)),
    removeItem: jest.fn((key) => values.delete(key)),
  };
}
const journal = (forecasts = [legacy, kalshi], scheduledForecast = null) =>
  JSON.stringify({ version: 7, forecasts, scheduledForecast });
const event = (id, outcomeDefinition) => ({ eventId: id, recordedAt: START, outcomeDefinition });

async function seed() {
  await appendEvidenceRows([
    event('old', legacy.outcomeDefinition),
    event('old-no-definition'),
    event('keep', KALSHI_OUTCOME_DEFINITION),
  ]);
  await queueForecastSnapshots([legacy, kalshi]);
}

describe('authorized removal of the old browser forecast data', () => {
  let originalFactory;
  beforeEach(() => {
    originalFactory = globalThis.indexedDB;
    globalThis.indexedDB = new IDBFactory();
  });
  afterEach(() => {
    globalThis.indexedDB = originalFactory;
  });

  test('removes only non-Kalshi journal, event and outbox rows, preserving Kalshi and unrelated storage', async () => {
    await seed();
    const local = storage({
      [JOURNAL]: journal(),
      'bitcoin-tracker:background-research:v1': 'old recorder',
      'bitcoin-tracker:background-research:legacy:v2': 'old alternate recorder',
      'bitcoin-tracker:background-research:kalshi:v2': 'keep recorder',
      'bitcoin-tracker:unrelated': 'keep setting',
    });
    expect(await cleanupLegacyBrowserResearch({ storage: local })).toEqual({
      forecasts: [kalshi],
      scheduledForecast: null,
    });
    expect(JSON.parse(local.getItem(JOURNAL))).toEqual({
      version: 7,
      forecasts: [kalshi],
      scheduledForecast: null,
    });
    expect(await readResearchOutbox()).toEqual({
      evidence: [event('keep', KALSHI_OUTCOME_DEFINITION)],
      forecasts: [kalshi],
    });
    expect(local.getItem('bitcoin-tracker:background-research:v1')).toBeNull();
    expect(local.getItem('bitcoin-tracker:background-research:legacy:v2')).toBeNull();
    expect(local.getItem('bitcoin-tracker:background-research:kalshi:v2')).toBe('keep recorder');
    expect(local.getItem('bitcoin-tracker:unrelated')).toBe('keep setting');
    await cleanupLegacyBrowserResearch({ storage: local });
    expect(await readResearchOutbox()).toEqual({
      evidence: [event('keep', KALSHI_OUTCOME_DEFINITION)],
      forecasts: [kalshi],
    });
  });

  test('preserves an armed future Kalshi market and removes an old custom schedule', async () => {
    const armed = storage({ [JOURNAL]: journal([], scheduled) });
    expect(await cleanupLegacyBrowserResearch({ storage: armed })).toEqual({
      forecasts: [],
      scheduledForecast: scheduled,
    });
    expect(armed.setItem).not.toHaveBeenCalled();
    const old = storage({
      [JOURNAL]: journal([], {
        ...scheduled,
        target: 50_000,
        outcomeDefinition: legacy.outcomeDefinition,
      }),
    });
    expect(await cleanupLegacyBrowserResearch({ storage: old })).toEqual({
      forecasts: [],
      scheduledForecast: null,
    });
    expect(JSON.parse(old.getItem(JOURNAL)).scheduledForecast).toBeNull();
  });

  test.each([
    'unreadable JSON',
    JSON.stringify({ version: 99, forecasts: [], scheduledForecast: null }),
    JSON.stringify({ version: 7, forecasts: [null], scheduledForecast: null }),
    journal([{ id: 'invalid-Kalshi', outcomeDefinition: KALSHI_OUTCOME_DEFINITION }]),
    JSON.stringify({ version: 6, forecasts: [kalshi], scheduledForecast: null }),
  ])(
    'preserves an unreadable or invalid journal and all evidence rather than treating it as empty',
    async (serialized) => {
      await seed();
      const before = await readResearchOutbox();
      const local = storage({ [JOURNAL]: serialized });
      await expect(cleanupLegacyBrowserResearch({ storage: local })).rejects.toThrow(
        /journal|Kalshi/i,
      );
      expect(local.getItem(JOURNAL)).toBe(serialized);
      expect(local.setItem).not.toHaveBeenCalled();
      expect(await readResearchOutbox()).toEqual(before);
    },
  );

  test('a failed IndexedDB transaction preserves both stores and the journal', async () => {
    await seed();
    const before = await readResearchOutbox();
    const local = storage({ [JOURNAL]: journal() });
    const openDatabase = async () => {
      const database = await openEvidenceDatabase();
      return {
        close: () => database.close(),
        transaction: (...args) => {
          const transaction = database.transaction(...args);
          queueMicrotask(() => transaction.abort());
          return transaction;
        },
      };
    };
    await expect(cleanupLegacyBrowserResearch({ storage: local, openDatabase })).rejects.toThrow(
      /failed|interrupted/,
    );
    expect(local.getItem(JOURNAL)).toBe(journal());
    expect(await readResearchOutbox()).toEqual(before);
    await expect(cleanupLegacyBrowserResearch({ storage: local })).resolves.toEqual({
      forecasts: [kalshi],
      scheduledForecast: null,
    });
  });

  test('retry finishes cleanup after IndexedDB committed but journal storage failed', async () => {
    await seed();
    const local = storage({
      [JOURNAL]: journal(),
      'bitcoin-tracker:background-research:v1': 'old',
    });
    local.setItem.mockImplementationOnce(() => {
      throw new Error('Storage quota failure');
    });
    await expect(cleanupLegacyBrowserResearch({ storage: local })).rejects.toThrow(
      'Storage quota failure',
    );
    expect(local.getItem(JOURNAL)).toBe(journal());
    expect(await readResearchOutbox()).toEqual({
      evidence: [event('keep', KALSHI_OUTCOME_DEFINITION)],
      forecasts: [kalshi],
    });
    await cleanupLegacyBrowserResearch({ storage: local });
    expect(JSON.parse(local.getItem(JOURNAL)).forecasts).toEqual([kalshi]);
    expect(local.getItem('bitcoin-tracker:background-research:v1')).toBeNull();
  });

  test('does not overwrite a newer Kalshi journal written by another tab during cleanup', async () => {
    const local = storage({ [JOURNAL]: journal() });
    const newer = journal([{ ...kalshi, id: 'newer' }]);
    const openDatabase = async () => {
      const database = await openEvidenceDatabase();
      local.setItem(JOURNAL, newer);
      return database;
    };
    await expect(cleanupLegacyBrowserResearch({ storage: local, openDatabase })).rejects.toThrow(
      /changed during cleanup/,
    );
    expect(local.getItem(JOURNAL)).toBe(newer);
    expect(await cleanupLegacyBrowserResearch({ storage: local })).toEqual({
      forecasts: [{ ...kalshi, id: 'newer' }],
      scheduledForecast: null,
    });
  });

  test('initializes an empty device and reports unavailable IndexedDB without changing its storage', async () => {
    const local = storage();
    expect(await cleanupLegacyBrowserResearch({ storage: local })).toEqual({
      forecasts: [],
      scheduledForecast: null,
    });
    expect(local.setItem).not.toHaveBeenCalled();
    delete globalThis.indexedDB;
    await expect(cleanupLegacyBrowserResearch({ storage: local })).rejects.toThrow(/unavailable/);
  });
});
