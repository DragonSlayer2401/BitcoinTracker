/** @jest-environment node */
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildEventDataset } from '../../utils/eventDataset.utils';
import { createEventReplay } from '../../utils/eventReplay.utils';
import { loadEventDatasetSources } from '@/services/research/eventDatasets/eventDatasetSources.service';
import {
  inspectEventDataset,
  serializeEventDataset,
} from '@/services/research/eventDatasets/eventDataset.repository';
import { createKalshiRecordingStore } from '@/services/kalshi/recording/kalshiRecording.repository';
import { createKalshiIngestionState } from '@/services/kalshi/ingestion/kalshiIngestionState.utils';
import { createSpotRecordingStore } from '@/services/coinbase/recording/spotRecording.repository';
import { createCoinbaseSpotNormalizer } from '@/services/coinbase/recording/coinbaseSpotNormalizer.utils';
import { fetchKalshiEventHistory } from '@/services/kalshi/history/kalshiEventHistory.service';
import { getKalshiReadResource } from '@/services/kalshi/rateLimit/rateLimit.policy';
import {
  createMarketMetadata,
  createSeriesMetadata,
  marketStart,
} from '@/features/SimulatedTrading/features/TradingAdvisor/__tests__/helpers/marketRulesFixtures';
import { runEventDatasetCommand } from '../../../../../../../scripts/build-events.runtime';

jest.mock('server-only', () => ({}));
const ticker = 'KXBTC15M-26NOV061900-00';
const closeAt = marketStart + 900_000;
const horizons = [12, 9, 6, 3, 1];
const configuration = { freshnessMs: 5000 };
let directory;
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'bitcoin-phase5-'));
});
afterEach(async () => {
  if (
    path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
    !path.basename(directory).startsWith('bitcoin-phase5-')
  )
    throw new Error('Unsafe fixture cleanup target.');
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// Synthetic recordings only; these prices and outcomes are not historical or performance evidence.
const fixtureInputs = ({
  missingSample = false,
  outcome = true,
  unsupported = false,
  lateLevel = false,
} = {}) => {
  const market = createMarketMetadata(
    unsupported ? { rules_secondary: 'Unsupported synthetic contract terms.' } : {},
  );
  const inputs = [
    { kind: 'series', receivedAt: marketStart - 1000, rawPayload: createSeriesMetadata() },
    {
      kind: 'market',
      receivedAt: marketStart,
      rawPayload: lateLevel ? { ...market, floor_strike: null } : market,
    },
    { kind: 'book-reset', receivedAt: marketStart + 1, tickers: [ticker] },
    { kind: 'book-connection', state: 'connected', receivedAt: marketStart + 1 },
    {
      kind: 'book-frame',
      receivedAt: marketStart + 1,
      rawPayload: JSON.stringify({
        type: 'subscribed',
        id: 1,
        msg: { channel: 'orderbook_delta', sid: 7 },
      }),
    },
  ];
  for (const [index, minutes] of horizons.entries()) {
    const receivedAt = closeAt - minutes * 60_000;
    const payload = Array.from({ length: 900 }, (_, second) => ({
      time: receivedAt - (899 - second) * 1000,
      value: '50000.12',
    }));
    if (missingSample) payload.splice(100, 1);
    inputs.push({
      kind: 'benchmark-rest',
      resourcePath: '/cfbenchmarks/values?id=BRTI&maxResolution=PER_SECOND',
      receivedAt,
      rawPayload: JSON.stringify({ data: { payload } }),
    });
    inputs.push({
      kind: 'book-frame',
      receivedAt,
      rawPayload: JSON.stringify({
        type: 'orderbook_snapshot',
        sid: 7,
        seq: index + 1,
        msg: {
          market_ticker: ticker,
          clock: 100 + index,
          yes_dollars_fp: [['0.4000', '2.50']],
          no_dollars_fp: [['0.5500', '3.00']],
        },
      }),
    });
    if (lateLevel && index === 0)
      inputs.push({ kind: 'market', receivedAt: receivedAt + 1, rawPayload: market });
  }
  if (outcome)
    inputs.push({
      kind: 'market',
      receivedAt: closeAt + 6000,
      rawPayload: {
        ...market,
        status: 'finalized',
        result: 'yes',
        expiration_value: '50000.12',
        settlement_value_dollars: '1.0000',
        settlement_ts: new Date(closeAt + 5000).toISOString(),
      },
    });
  inputs.push({ kind: 'capture-stopped', receivedAt: closeAt + 7000 });
  return inputs;
};
const normalize = (inputs) => {
  const state = createKalshiIngestionState(configuration);
  return inputs.map((input, index) => ({
    schemaVersion: 'event-source-record-v1',
    id: `fixture:${index + 1}`,
    sourceId: 'fixture',
    sourceKind: 'kalshi',
    captureSequence: 1,
    ordinal: index + 1,
    receivedAt: input.receivedAt,
    availableAt: input.receivedAt,
    provenance: 'synthetic-fixture',
    configuration,
    input,
    normalized: state.apply(input),
  }));
};
const saveRecording = async (inputs = fixtureInputs(), name = 'recording') => {
  let now = marketStart - 1000;
  const location = path.join(directory, name);
  const store = await createKalshiRecordingStore({ directory: location, now: () => now });
  for (const record of normalize(inputs)) {
    now = record.receivedAt;
    await store.append({
      schemaVersion: 'kalshi-market-recording-v1',
      ordinal: record.ordinal,
      configuration,
      input: record.input,
      normalized: record.normalized,
    });
  }
  await store.close();
  return location;
};

test('build → inspect → replay produces identical artifacts with five horizons and separate official labels', async () => {
  const recording = await saveRecording();
  const output = path.join(directory, 'dataset');
  const logs = [];
  const result = await runEventDatasetCommand(
    ['build', '--kalshi-directory', recording, '--synthetic', '--output', output, '--json'],
    { write: (text) => logs.push(text) },
  );
  expect(result.manifest.counts).toEqual({ events: 1, snapshots: 5, labels: 1 });
  const inspected = await inspectEventDataset(output);
  expect(inspected.verified).toBe(true);
  expect(inspected.quality.featureReadySnapshots).toBe(5);
  const snapshots = (await readFile(path.join(output, 'snapshots.jsonl'), 'utf8'))
    .trim()
    .split('\n')
    .map(JSON.parse);
  expect(snapshots.map((snapshot) => snapshot.horizonMinutes)).toEqual(horizons);
  expect(
    snapshots.every((snapshot) => snapshot.schemaVersion === 'event-feature-snapshot-v1'),
  ).toBe(true);
  const labels = JSON.parse((await readFile(path.join(output, 'labels.jsonl'), 'utf8')).trim());
  expect(labels).toMatchObject({
    result: 'YES',
    availableAt: closeAt + 6000,
    provenance: 'synthetic-fixture',
  });
  expect(JSON.stringify(snapshots)).not.toMatch(
    /finalOutcome|reportedResult|settlementIndexValue|payoutDollars|"settledAt"/,
  );
  expect(
    (
      await runEventDatasetCommand(
        ['replay', '--dataset', output, '--kalshi-directory', recording, '--synthetic', '--json'],
        { write: () => {} },
      )
    ).matches,
  ).toBe(true);
  const second = await runEventDatasetCommand(
    [
      'build',
      '--kalshi-directory',
      recording,
      '--synthetic',
      '--output',
      path.join(directory, 'again'),
    ],
    { write: () => {} },
  );
  expect(second.manifest).toEqual(result.manifest);
  await expect(
    runEventDatasetCommand(['build', '--kalshi-directory', recording, '--output', output], {
      write: () => {},
    }),
  ).rejects.toThrow();
});

test('changing future prices, reference revisions, book quotes and final outcomes leaves earlier snapshots byte-identical', () => {
  const inputs = fixtureInputs();
  const decisionAt = closeAt - 12 * 60_000;
  const changed = inputs.map((input) => {
    if (input.receivedAt <= decisionAt) return input;
    if (input.kind === 'benchmark-rest') {
      const payload = JSON.parse(input.rawPayload);
      payload.data.payload.forEach((sample) => {
        sample.value = '59999.99';
      });
      return { ...input, rawPayload: JSON.stringify(payload) };
    }
    if (input.kind === 'book-frame') {
      const payload = JSON.parse(input.rawPayload);
      payload.msg.yes_dollars_fp = [['0.1000', '99.25']];
      return { ...input, rawPayload: JSON.stringify(payload) };
    }
    if (input.kind === 'market')
      return {
        ...input,
        rawPayload: {
          ...input.rawPayload,
          result: 'no',
          expiration_value: '49000',
          floor_strike: '51000',
        },
      };
    return input;
  });
  const first = buildEventDataset({ records: normalize(inputs) });
  const second = buildEventDataset({ records: normalize(changed) });
  expect(JSON.stringify(second.snapshots[0])).toBe(JSON.stringify(first.snapshots[0]));
  expect(second.labels).not.toEqual(first.labels);
  expect(second.snapshots[1].modelInputs.reference.latest.value).toBe('59999.99');
});

test('actual opening-reference availability and later corrections are visible only after receipt', () => {
  const inputs = fixtureInputs({ lateLevel: true });
  const firstAt = closeAt - 12 * 60_000;
  const records = normalize(inputs);
  const replay = createEventReplay({ records });
  expect(replay.asOf(ticker, firstAt).contract.reference.openingLevel).toBeNull();
  expect(replay.asOf(ticker, firstAt + 1).contract.reference).toMatchObject({
    openingLevel: '50000',
    availableAt: firstAt + 1,
    revision: 1,
  });
  const revisedInput = {
    kind: 'market',
    receivedAt: firstAt + 3,
    rawPayload: createMarketMetadata({ floor_strike: '50001.25' }),
  };
  const revised = normalize(
    [
      ...inputs.slice(0, 8),
      {
        kind: 'market',
        receivedAt: firstAt + 2,
        rawPayload: createMarketMetadata({ floor_strike: '50000.00' }),
      },
      revisedInput,
      ...inputs.slice(8),
    ].sort((left, right) => left.receivedAt - right.receivedAt),
  );
  const later = createEventReplay({ records: revised });
  expect(later.asOf(ticker, firstAt + 2).contract.reference).toMatchObject({
    revision: 1,
    availableAt: firstAt + 1,
  });
  expect(later.asOf(ticker, firstAt + 3).contract.reference).toMatchObject({
    openingLevel: '50001.25',
    availableAt: firstAt + 3,
    revision: 2,
  });
  expect(later.asOf(ticker, firstAt).contract.reference.openingLevel).toBeNull();
});

test('clock rewind, repeated runs and shuffled input ordering are deterministic', () => {
  const records = normalize(fixtureInputs());
  const replay = createEventReplay({ records: [...records].reverse() });
  const firstAt = closeAt - 12 * 60_000;
  replay.clock.set(firstAt);
  const first = replay.asOf(ticker);
  replay.clock.advance(180_000);
  expect(replay.asOf(ticker).decisionAt).toBe(firstAt + 180_000);
  replay.clock.set(firstAt);
  expect(replay.asOf(ticker)).toEqual(first);
  expect(() => replay.clock.advance(-1)).toThrow();
  expect(serializeEventDataset(buildEventDataset({ records })).manifest).toEqual(
    serializeEventDataset(buildEventDataset({ records: [...records].reverse() })).manifest,
  );
});

test('labels never enter prediction inputs even when querying after official settlement', () => {
  const observed = createEventReplay({ records: normalize(fixtureInputs()) }).asOf(
    ticker,
    closeAt + 6000,
  );
  expect(observed.contract.lifecycle.state).toBe('finalized');
  expect(JSON.stringify(observed.contract)).not.toMatch(
    /finalOutcome|reportedResult|settlementIndexValue|payoutDollars|"settledAt"/,
  );
  expect(observed.modelInputs).not.toHaveProperty('kalshiBook');
});

test('missing samples, excluded contracts, unresolved outcomes and unavailable depth remain in quality reports', () => {
  const records = normalize(
    fixtureInputs({ missingSample: true, outcome: false, unsupported: true }).filter(
      (input) => !input.kind.startsWith('book-'),
    ),
  );
  const dataset = buildEventDataset({
    records,
    issues: [
      { code: 'historical_market_missing', ticker: 'KXBTC15M-26NOV061930-00', sourceId: 'fixture' },
    ],
  });
  expect(dataset.events).toHaveLength(2);
  expect(dataset.quality.unresolvedEvents).toHaveLength(2);
  expect(dataset.quality.excludedEvents).toHaveLength(2);
  expect(dataset.quality.missingReferenceSamples.length).toBeGreaterThan(0);
  expect(dataset.quality.inadequateHistoricalDepth).toHaveLength(5);
  expect(dataset.events[0].referenceCoverage.closing.missingSamples).toBe(60);
  expect(dataset.labels).toEqual([]);
  expect(dataset.snapshots).toHaveLength(5);
});

test('book gaps and stale inputs remain unavailable in replay; quote changes do not change model inputs', () => {
  const inputs = fixtureInputs();
  const decisionAt = closeAt - 12 * 60_000;
  const records = normalize(inputs);
  const first = createEventReplay({ records }).asOf(ticker, decisionAt);
  const changed = inputs.map((input) => {
    if (input.kind !== 'book-frame' || input.receivedAt !== decisionAt) return input;
    const frame = JSON.parse(input.rawPayload);
    frame.msg.yes_dollars_fp = [['0.3000', '7.25']];
    return { ...input, rawPayload: JSON.stringify(frame) };
  });
  const other = createEventReplay({ records: normalize(changed) }).asOf(ticker, decisionAt);
  expect(other.modelInputs).toEqual(first.modelInputs);
  expect(other.tradingInputs).not.toEqual(first.tradingInputs);
  expect(
    createEventReplay({ records }).asOf(ticker, decisionAt + 5001).tradingInputs.kalshiBook
      .available,
  ).toBe(false);
  const gap = {
    kind: 'book-frame',
    receivedAt: decisionAt + 1,
    rawPayload: JSON.stringify({
      type: 'orderbook_delta',
      sid: 7,
      seq: 3,
      msg: {
        market_ticker: ticker,
        clock: 103,
        price_dollars: '0.4000',
        delta_fp: '1.00',
        side: 'yes',
        ts_ms: decisionAt + 1,
      },
    }),
  };
  const withGap = normalize([...inputs.filter((input) => input.receivedAt <= decisionAt), gap]);
  expect(
    createEventReplay({ records: withGap }).asOf(ticker, decisionAt + 1).tradingInputs.kalshiBook
      .available,
  ).toBe(false);
});

test('history fetch uses documented fallback and preserves missing entitlement and actual fetch availability', async () => {
  const retrievedAt = closeAt + 7200_000;
  const hour = Math.floor(marketStart / 3600_000) * 3600_000;
  const calls = [];
  const supplement = await fetchKalshiEventHistory({
    tickers: [ticker],
    referenceHours: [hour],
    now: () => retrievedAt,
    request: async (resourcePath) => {
      getKalshiReadResource(resourcePath);
      calls.push(resourcePath);
      if (resourcePath.startsWith('/series/')) return createSeriesMetadata();
      if (resourcePath === `/markets/${ticker}`)
        throw Object.assign(new Error('Synthetic 404.'), { status: 404 });
      if (resourcePath.startsWith('/historical/markets/'))
        return {
          market: createMarketMetadata({
            status: 'finalized',
            result: 'yes',
            expiration_value: '50000.12',
          }),
        };
      return { data: { payload: [{ time: hour + 1000, value: '5.000012e4' }] } };
    },
  });
  expect(calls).toContain(`/historical/markets/${ticker}`);
  expect(supplement.coverage.referenceHours[0].missingSeconds).toBe(3599);
  const filename = path.join(directory, 'history.json');
  await writeFile(filename, JSON.stringify(supplement));
  const sourceData = await loadEventDatasetSources({ historicalFiles: [filename] });
  expect(
    sourceData.records.every(
      (record) =>
        record.provenance === 'retrospective-history' && record.availableAt === retrievedAt,
    ),
  ).toBe(true);
  const dataset = buildEventDataset(sourceData);
  expect(
    dataset.snapshots.every(
      (snapshot) =>
        snapshot.contract === null && snapshot.modelInputs.reference.observations.length === 0,
    ),
  ).toBe(true);
  expect(dataset.labels[0]).toMatchObject({
    result: 'YES',
    availableAt: retrievedAt,
    provenance: 'retrospective-history',
  });
  expect(dataset.quality.inadequateHistoricalDepth).toHaveLength(5);
  const denied = await fetchKalshiEventHistory({
    tickers: [],
    referenceHours: [hour],
    now: () => retrievedAt,
    request: async (resourcePath) => {
      if (resourcePath.startsWith('/series/')) return createSeriesMetadata();
      throw Object.assign(new Error('Synthetic entitlement denial.'), { status: 403 });
    },
  });
  expect(denied.requests.some((request) => request.status === 'unauthorized')).toBe(true);
  await expect(
    fetchKalshiEventHistory({ tickers: [], referenceHours: [retrievedAt], now: () => retrievedAt }),
  ).rejects.toThrow(/UTC-hour/);
});

test('an incomplete or clock-regressed source is reported without silently admitting its partial data', async () => {
  const location = path.join(directory, 'incomplete');
  const store = await createKalshiRecordingStore({ directory: location, now: () => marketStart });
  await store.close({ complete: false, error: 'Synthetic interruption.' });
  const result = await loadEventDatasetSources({ kalshiDirectories: [location], synthetic: true });
  expect(result.records).toEqual([]);
  expect(result.sources[0].status).toBe('excluded');
  expect(buildEventDataset(result).quality.sourceIssues.length).toBeGreaterThan(0);
  const regressedInputs = fixtureInputs().map((input, index) =>
    index === 3 ? { ...input, receivedAt: marketStart - 1 } : input,
  );
  const regressed = await saveRecording(regressedInputs, 'regressed');
  const rejected = await loadEventDatasetSources({
    kalshiDirectories: [regressed],
    synthetic: true,
  });
  expect(rejected.records).toEqual([]);
  expect(rejected.issues.some((issue) => issue.code === 'receive_clock_regressed')).toBe(true);
});

test('tampered dataset output fails inspection rather than replaying modified labels', async () => {
  const recording = await saveRecording();
  const output = path.join(directory, 'dataset');
  await runEventDatasetCommand(
    ['build', '--kalshi-directory', recording, '--synthetic', '--output', output],
    { write: () => {} },
  );
  await writeFile(path.join(output, 'labels.jsonl'), '{}\n');
  await expect(inspectEventDataset(output)).rejects.toThrow(/checksum/);
});

test('a recorded Coinbase feed joins as a proxy with original receipt times and stays separate from BRTI', async () => {
  const at = closeAt - 12 * 60_000;
  let now = at;
  const store = await createSpotRecordingStore({
    directory: path.join(directory, 'spot'),
    now: () => now,
  });
  const normalizer = createCoinbaseSpotNormalizer(configuration);
  const frame = (payload) => ({
    kind: 'message',
    receivedAt: at,
    connectionId: 1,
    payload: JSON.stringify(payload),
  });
  const inputs = [
    { kind: 'connection', state: 'connecting', receivedAt: at, connectionId: 1 },
    { kind: 'connection', state: 'connected', receivedAt: at, connectionId: 1 },
    frame({
      type: 'subscriptions',
      channels: ['matches', 'heartbeat', 'ticker', 'level2_batch'].map((name) => ({
        name,
        product_ids: ['BTC-USD'],
      })),
    }),
    frame({
      type: 'heartbeat',
      product_id: 'BTC-USD',
      sequence: 199,
      last_trade_id: 10,
      time: new Date(at).toISOString(),
    }),
    frame({
      type: 'ticker',
      product_id: 'BTC-USD',
      sequence: 200,
      trade_id: 10,
      time: new Date(at).toISOString(),
      price: '49999.12',
      best_bid: '49998.00',
      best_ask: '50000.00',
      best_bid_size: '0.1',
      best_ask_size: '0.2',
    }),
    { kind: 'connection', state: 'stopped', receivedAt: at + 10_000, connectionId: 1 },
  ];
  for (const [index, input] of inputs.entries()) {
    now = input.receivedAt;
    await store.append({
      schemaVersion: 'coinbase-spot-recording-v1',
      ordinal: index + 1,
      configuration,
      input,
      normalized: normalizer.apply(input),
    });
  }
  await store.close();
  const kalshiDirectory = await saveRecording();
  const loaded = await loadEventDatasetSources({
    kalshiDirectories: [kalshiDirectory],
    spotFiles: [store.location],
    synthetic: true,
  });
  expect(loaded.sources.every((source) => source.status === 'verified')).toBe(true);
  const observed = createEventReplay({ records: loaded.records }).asOf(ticker, at);
  expect(observed.modelInputs.spot).toMatchObject({
    available: true,
    sourceKind: 'proxy',
    latest: { price: '49999.12', receivedAt: at },
  });
  expect(observed.modelInputs.reference.latest.value).toBe('50000.12');
  expect(observed.modelInputs.spot.latest.originalAvailability).toBe('synthetic-receipt');
});

test('late metadata and backdated availability cannot expose an unknown contract at earlier horizons', () => {
  const at = closeAt - 12 * 60_000;
  const records = normalize(fixtureInputs()).map((record) =>
    record.input.kind === 'market' && record.receivedAt <= at
      ? { ...record, receivedAt: at + 1, availableAt: marketStart }
      : record,
  );
  const snapshot = createEventReplay({ records }).asOf(ticker, at);
  expect(snapshot.contract).toBeNull();
  expect(createEventReplay({ records }).asOf(ticker, at + 1).contract).toBeNull();
});

test('a successful historical fallback diagnostic does not exclude an otherwise complete event', () => {
  const dataset = buildEventDataset({
    records: normalize(fixtureInputs()),
    issues: [
      { sourceId: 'history', ticker, code: 'historical_request_unavailable', status: 'missing' },
    ],
  });
  expect(dataset.events[0].status).toBe('ready');
  expect(dataset.quality.sourceIssues).toHaveLength(1);
});

test('coverage uses the latest locally known reference revision, and unresolved events remain represented', () => {
  const inputs = fixtureInputs({ outcome: false });
  const reference = (receivedAt, repeated) => ({
    kind: 'benchmark-rest',
    resourcePath: '/cfbenchmarks/values?id=BRTI',
    receivedAt,
    rawPayload: JSON.stringify({
      data: {
        payload: [{ time: closeAt - 1000, value: '50001', repeatOfPreviousValue: repeated }],
      },
    }),
  });
  const revised = [
    ...inputs,
    reference(closeAt - 1000, false),
    reference(closeAt - 500, true),
  ].sort((left, right) => left.receivedAt - right.receivedAt);
  const dataset = buildEventDataset({ records: normalize(revised) });
  expect(dataset.events[0]).toMatchObject({
    status: 'unresolved',
    resolutionStatus: 'unresolved',
    referenceCoverage: { closingKnownAtClose: { observedSamples: 0, missingSamples: 60 } },
  });
  expect(dataset.snapshots.every((snapshot) => snapshot.eligibility.featureReady)).toBe(true);
  expect(dataset.labels).toEqual([]);
});
