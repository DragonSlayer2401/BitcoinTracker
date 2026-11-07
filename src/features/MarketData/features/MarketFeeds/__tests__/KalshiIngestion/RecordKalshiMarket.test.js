/** @jest-environment node */
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';
import {
  createKalshiRecorder,
  inspectKalshiArchive,
} from '@/services/kalshi/ingestion/kalshiIngestion.service';
import { createKalshiBookStream } from '@/services/kalshi/ingestion/kalshiBookStream.service';
import {
  createKalshiBookState,
  normalizeKalshiRestBook,
} from '@/services/kalshi/ingestion/kalshiBook.utils';
import { createKalshiReferenceNormalizer } from '@/services/kalshi/ingestion/kalshiReference.utils';
import { createKalshiMarketHistory } from '@/services/kalshi/ingestion/kalshiMarket.utils';
import {
  createKalshiRecordingStore,
  readKalshiArchive,
} from '@/services/kalshi/recording/kalshiRecording.repository';
import { getKalshiReadResource } from '@/services/kalshi/rateLimit/rateLimit.policy';
import { runKalshiCaptureCommand } from '../../../../../../../scripts/capture-kalshi.runtime';
import {
  createMarketMetadata,
  createSeriesMetadata,
  marketNow,
} from '@/features/SimulatedTrading/features/TradingAdvisor/__tests__/helpers/marketRulesFixtures';

jest.mock('server-only', () => ({}));

// Entire workflow is synthetic. These prices, market states and frames are not live evidence.
const ticker = 'KXBTC15M-26NOV061900-00';
const referencePath = '/cfbenchmarks/values?id=BRTI&maxResolution=PER_SECOND';
const bids = { yes_dollars: [['0.4000', '2.50']], no_dollars: [['0.5500', '3.00']] };
const subscribed = { id: 1, type: 'subscribed', msg: { channel: 'orderbook_delta', sid: 7 } };
const snapshot = (seq = 1, changes = {}) => ({
  type: 'orderbook_snapshot',
  sid: 7,
  seq,
  sending_ts_ms: marketNow,
  msg: {
    market_ticker: ticker,
    clock: 100 + seq,
    yes_dollars_fp: bids.yes_dollars,
    no_dollars_fp: bids.no_dollars,
    ...changes,
  },
});
const delta = (seq, changes = {}) => ({
  type: 'orderbook_delta',
  sid: 7,
  seq,
  msg: {
    market_ticker: ticker,
    clock: 100 + seq,
    price_dollars: '0.4000',
    delta_fp: '1.25',
    side: 'yes',
    ts_ms: marketNow,
    ...changes,
  },
});
const referenceInput = (value, receivedAt, extra = {}) => ({
  kind: 'benchmark-rest',
  resourcePath: referencePath,
  receivedAt,
  rawPayload: JSON.stringify({ data: { payload: [{ time: marketNow, value, ...extra }] } }),
});

let directories;
let recorders;
let time;
let sockets;
let environment;
class FixtureSocket extends EventEmitter {
  sent = [];
  constructor() {
    super();
    sockets.push(this);
  }
  send = (payload) => this.sent.push(JSON.parse(payload));
  terminate = () => {};
  frame = (payload) => this.emit('message', Buffer.from(JSON.stringify(payload)), false);
}
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  environment = { KALSHI_API_KEY_ID: 'synthetic-test-key', KALSHI_PRIVATE_KEY: privateKey };
});
beforeEach(() => {
  directories = [];
  recorders = [];
  sockets = [];
  time = marketNow;
});
afterEach(async () => {
  for (const recorder of recorders) await recorder.stop().catch(() => {});
  for (const directory of directories) {
    if (
      path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) ||
      !path.basename(directory).startsWith('bitcoin-kalshi-phase4-')
    )
      throw new Error('Refusing cleanup outside the owned temporary fixture directory.');
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
const newDirectory = async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bitcoin-kalshi-phase4-'));
  directories.push(directory);
  return directory;
};
const setup = async ({ directory, credentials = true, ...options } = {}) => {
  let market = createMarketMetadata();
  let reference = '5.000012e4';
  const requests = [];
  const request = async (resourcePath) => {
    getKalshiReadResource(resourcePath);
    requests.push(resourcePath);
    if (resourcePath === '/series/KXBTC15M') return createSeriesMetadata();
    if (resourcePath.startsWith('/markets?'))
      return {
        markets:
          resourcePath.includes('status=open&') && market.status === 'active' ? [market] : [],
        cursor: '',
      };
    if (resourcePath.endsWith('/orderbook?depth=100')) return { orderbook_fp: bids };
    if (resourcePath === `/markets/${ticker}`) return { market };
    if (resourcePath === referencePath)
      return JSON.parse(referenceInput(reference, time).rawPayload);
    throw new Error('Unexpected fixture request.');
  };
  const selected = directory ?? (await newDirectory());
  const recorder = await createKalshiRecorder({
    directory: selected,
    now: () => time,
    getEnvironment: () => (credentials ? environment : {}),
    request,
    createBookStream: (settings) =>
      createKalshiBookStream({ ...settings, WebSocketImpl: FixtureSocket }),
    createReferenceStream: () => ({
      start: () => {},
      stop: () => {},
      getStatus: () => ({ status: 'connecting' }),
    }),
    ...options,
  });
  recorders.push(recorder);
  return {
    recorder,
    directory: selected,
    requests,
    setMarket: (value) => {
      market = value;
    },
    setReference: (value) => {
      reference = value;
    },
  };
};

test('record → inspect shows contract, complementary executable depth, clock provenance and official reference', async () => {
  const { recorder, directory } = await setup();
  await recorder.start();
  sockets[0].emit('open');
  sockets[0].frame(subscribed);
  sockets[0].frame(snapshot());
  sockets[0].frame(delta(2));
  const report = await recorder.getStatus();
  const book = report.snapshot.orderBooks.books[ticker];
  expect(book.available).toBe(true);
  expect(book.yesBids).toEqual([{ priceUnits: '4000', quantityUnits: '375' }]);
  expect(book.noAsks).toEqual([{ priceUnits: '6000', quantityUnits: '375' }]);
  expect(book.yesAsks).toEqual([{ priceUnits: '4500', quantityUnits: '300' }]);
  const fresh = normalizeKalshiRestBook(
    { orderbook_fp: { ...bids, yes_dollars: [['0.4000', '3.75']] } },
    ticker,
    time,
  );
  for (const side of ['yesBids', 'noBids', 'yesAsks', 'noAsks'])
    expect(book[side]).toEqual(fresh[side]);
  expect(report.snapshot.markets[0].reference).toMatchObject({
    sourceKind: 'official',
    openingLevel: '50000',
  });
  expect(report.snapshot.referenceFeed).toMatchObject({
    available: true,
    latest: { value: '50000.12', sourcePublishedAt: null, firstSeenAt: marketNow },
  });
  await recorder.stop();
  const lines = [];
  const inspected = await runKalshiCaptureCommand(['inspect', '--directory', directory, '--json'], {
    now: () => time,
    write: (line) => lines.push(line),
  });
  expect(inspected.replayVerified).toBe(true);
  expect(inspected.snapshot.orderBooks.available).toBe(false);
  expect(inspected.snapshot.referenceFeed.available).toBe(false);
  expect(inspected.snapshot.independentRestBooks.every((book) => !book.available)).toBe(true);
  expect(JSON.parse(lines[0]).snapshot.orderSubmissionEnabled).toBe(false);
});

test('a subscription gap blocks depth until replacement snapshots and sends only data commands', async () => {
  const { recorder } = await setup();
  await recorder.start();
  const socket = sockets[0];
  socket.emit('open');
  socket.frame(subscribed);
  socket.frame(snapshot());
  socket.frame(delta(3));
  expect((await recorder.getStatus()).snapshot.orderBooks.books[ticker]).toMatchObject({
    available: false,
    yesAsks: [],
  });
  expect(socket.sent.at(-1)).toMatchObject({
    cmd: 'update_subscription',
    params: { action: 'get_snapshot', sid: 7 },
  });
  socket.frame(delta(4));
  expect((await recorder.getStatus()).snapshot.orderBooks.available).toBe(false);
  socket.frame(snapshot(5));
  expect((await recorder.getStatus()).snapshot.orderBooks.available).toBe(true);
  expect(
    socket.sent.every((command) => ['subscribe', 'update_subscription'].includes(command.cmd)),
  ).toBe(true);
  time += 5001;
  expect((await recorder.getStatus()).snapshot.orderBooks.books[ticker].reason).toBe('stale_book');
});

test('duplicate, regressed and negative-quantity events never create fresh or invented liquidity', () => {
  const book = createKalshiBookState({ tickers: [ticker] });
  book.accept(subscribed, time);
  book.accept(snapshot(), time);
  expect(book.accept(snapshot(), time + 4000).disposition).toBe('duplicate');
  expect(book.getSnapshot(time + 5001).available).toBe(false);
  expect(book.accept(delta(2, { delta_fp: '-3.00' }), time + 4001).disposition).toBe('invalid');
  expect(book.getSnapshot(time + 4001).available).toBe(false);
  book.accept(snapshot(3), time + 4002);
  expect(book.accept(delta(2), time + 4003).reason).toBe('conflicting_book_sequence');
});

test('subscription-wide sequences and controls cover both markets; every gapped market needs a snapshot', () => {
  const second = 'KXBTC15M-26NOV061915-00';
  const book = createKalshiBookState({ tickers: [ticker, second] });
  book.accept(subscribed, time);
  book.accept(snapshot(), time);
  book.accept(snapshot(2, { market_ticker: second }), time);
  book.accept({ type: 'ok', sid: 7, seq: 3 }, time);
  expect(book.getSnapshot(time).available).toBe(true);
  book.accept(delta(5), time);
  book.accept(snapshot(6), time);
  expect(book.getSnapshot(time).available).toBe(false);
  book.accept(snapshot(7, { market_ticker: second }), time);
  expect(book.getSnapshot(time).available).toBe(true);
});

test.each([[['0.40001', '2.00']], [['0.4000', '2.001']], [['0.4000', '-1.00']]])(
  'invalid fixed-point source depth is rejected: %j',
  (yes) => {
    const book = createKalshiBookState({ tickers: [ticker] });
    book.accept(subscribed, time);
    expect(book.accept(snapshot(1, { yes_dollars_fp: yes }), time).disposition).toBe('invalid');
    expect(book.getSnapshot(time).available).toBe(false);
  },
);

test('crossed snapshots are unusable, and empty sides do not manufacture executable asks', () => {
  const crossed = normalizeKalshiRestBook(
    { orderbook_fp: { yes_dollars: [['0.9000', '1.00']], no_dollars: [['0.2000', '1.00']] } },
    ticker,
    time,
  );
  expect(crossed).toMatchObject({ available: false, yesAsks: [], reason: 'crossed_book' });
  const empty = normalizeKalshiRestBook(
    { orderbook_fp: { yes_dollars: [], no_dollars: [] } },
    ticker,
    time,
  );
  expect(empty.yesAsks).toEqual([]);
  expect(empty.noAsks).toEqual([]);
});

test('close and determination remain pending; only exchange finalization creates the authoritative result', async () => {
  const fixture = await setup();
  await fixture.recorder.start();
  time += 1000;
  fixture.setMarket(createMarketMetadata({ status: 'closed', result: 'yes' }));
  await fixture.recorder.poll();
  expect((await fixture.recorder.getStatus()).snapshot.markets[0].finalOutcome).toBeNull();
  fixture.setMarket(createMarketMetadata({ status: 'determined', result: 'yes' }));
  time += 1000;
  await fixture.recorder.poll();
  expect((await fixture.recorder.getStatus()).snapshot.markets[0].finalOutcome).toBeNull();
  fixture.setMarket(
    createMarketMetadata({ status: 'finalized', result: 'yes', expiration_value: '50001.25' }),
  );
  time += 1000;
  await fixture.recorder.poll();
  const final = (await fixture.recorder.getStatus()).snapshot.markets[0].finalOutcome;
  expect(final).toMatchObject({
    authoritative: true,
    result: 'YES',
    settlementIndexValue: '50001.25',
    settlementAt: null,
  });
  await fixture.recorder.stop();
  const transitions = [];
  for await (const { record } of readKalshiArchive(fixture.directory))
    if (record.normalized.stateChange) transitions.push(record.normalized.stateChange.to);
  expect(transitions).toEqual(['closed', 'determined', 'finalized']);
});

test('first-seen reference evidence and later revisions survive stop/restart without refreshing old values', async () => {
  const fixture = await setup();
  await fixture.recorder.start();
  await fixture.recorder.stop();
  time += 1000;
  const resumed = await setup({ directory: fixture.directory });
  await resumed.recorder.start();
  expect((await resumed.recorder.getStatus()).snapshot.referenceFeed.latest.firstSeenAt).toBe(
    marketNow,
  );
  resumed.setReference('50001.00');
  time += 1000;
  await resumed.recorder.poll();
  expect((await resumed.recorder.getStatus()).snapshot.referenceFeed.latest).toMatchObject({
    value: '50001',
    revision: 2,
    firstSeenAt: time,
  });
  resumed.setReference('50000.12');
  time += 1000;
  await resumed.recorder.poll();
  expect((await resumed.recorder.getStatus()).snapshot.referenceFeed.latest.revision).toBe(3);
  await resumed.recorder.stop();
  const inspected = await inspectKalshiArchive(fixture.directory, { now: () => time });
  expect(inspected.replayVerified).toBe(true);
  expect(inspected.storage.retainedHistory.lastCaptureSequence).toBe(2);
});

test('reference revisions keep original clocks, as-of views, repeats and proxy rejection distinct', () => {
  const reference = createKalshiReferenceNormalizer();
  reference.apply(referenceInput('5.000012e4', time));
  reference.apply(referenceInput('50000.120', time + 1));
  reference.apply(referenceInput('50001', time + 2, { amendTime: time + 2 }));
  expect(reference.getStatus(time + 1).latest).toMatchObject({
    value: '50000.12',
    firstSeenAt: time,
    sourcePublishedAt: null,
  });
  expect(reference.getStatus(time + 2).latest).toMatchObject({
    value: '50001',
    sourceAmendedAt: time + 2,
    revision: 2,
  });
  expect(
    reference.apply({ ...referenceInput('50002', time + 3), resourcePath: '/coinbase/ticker' })
      .disposition,
  ).toBe('invalid');
});

test('missing credentials exposes unavailable official data and an explicit separate exchange proxy', async () => {
  const { recorder, requests } = await setup({ credentials: false });
  await recorder.start();
  const report = await recorder.getStatus();
  expect(report.snapshot.referenceFeed).toMatchObject({
    status: 'not-configured',
    available: false,
    sourceAgencyOutage: null,
  });
  expect(report.snapshot.exchangeProxy).toMatchObject({
    sourceKind: 'proxy',
    usableForOfficialSettlement: false,
  });
  expect(report.snapshot.orderBooks.available).toBe(false);
  expect(requests).not.toContain(referencePath);
});

test('discovery follows opaque cursors, retains upcoming markets, and does not combine status with close filters', async () => {
  const requests = [];
  const upcoming = createMarketMetadata({
    ticker: 'KXBTC15M-26NOV061915-00',
    event_ticker: 'KXBTC15M-26NOV061915',
    startsAt: marketNow + 900000,
    status: 'initialized',
    floor_strike: null,
  });
  const request = async (resourcePath) => {
    getKalshiReadResource(resourcePath);
    requests.push(resourcePath);
    if (resourcePath === '/series/KXBTC15M') return createSeriesMetadata();
    if (resourcePath.includes('status=open&') && !resourcePath.includes('cursor='))
      return { markets: [], cursor: 'opaque/+=token' };
    if (resourcePath.includes('status=unopened&')) return { markets: [upcoming], cursor: '' };
    return { markets: [], cursor: '' };
  };
  const { recorder } = await setup({ request, credentials: false });
  await recorder.start();
  expect((await recorder.getStatus()).snapshot.markets[0]).toMatchObject({
    ticker: upcoming.ticker,
    reference: { openingLevel: null },
    finalOutcome: null,
  });
  expect(requests.some((value) => value.includes('cursor=opaque%2F%2B%3Dtoken'))).toBe(true);
  expect(requests.some((value) => value.includes('max_close_ts'))).toBe(false);
  expect(() => getKalshiReadResource('/portfolio/orders')).toThrow();
});

test('an incomplete archive blocks a new session instead of forgetting first-seen history', async () => {
  const directory = await newDirectory();
  const store = await createKalshiRecordingStore({ directory, now: () => time });
  await store.close({ complete: false, error: 'Synthetic interruption.' });
  await expect(createKalshiRecorder({ directory, now: () => time })).rejects.toThrow(/incomplete/i);
});

test('a storage failure reports only acknowledged writes and disables availability', async () => {
  const store = {
    readPriorArchive: () => [],
    append: async () => {
      throw new Error('Synthetic disk failure.');
    },
    close: async () => {},
    getStatus: async () => ({ recordCount: 0 }),
    location: 'synthetic-memory-store',
    captureSequence: 1,
  };
  const { recorder } = await setup({ createStore: async () => store });
  await recorder.start();
  const report = await recorder.getStatus();
  expect(report).toMatchObject({
    state: 'failed',
    writtenRecords: 0,
    failureCode: 'storage_append_failed',
  });
  expect(report.unpersistedRecords).toBeGreaterThan(0);
  expect(report.snapshot.orderBooks.available).toBe(false);
  expect(report.snapshot.referenceFeed.available).toBe(false);
  await expect(recorder.stop()).rejects.toThrow(/incomplete/);
});

test('queue overflow drains the accepted prefix and never starts a socket after failure', async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const saved = [];
  const store = {
    readPriorArchive: () => [],
    append: async (row) => {
      await gate;
      saved.push(row);
    },
    close: async () => {},
    getStatus: async () => ({ recordCount: saved.length }),
    location: 'synthetic-memory-store',
    captureSequence: 1,
  };
  const { recorder } = await setup({ createStore: async () => store, maxPendingRecords: 2 });
  await recorder.start();
  release();
  const report = await recorder.getStatus();
  expect(report).toMatchObject({
    state: 'failed',
    failureCode: 'pending_queue_limit',
    writtenRecords: 2,
    unpersistedRecords: 0,
  });
  expect(saved).toHaveLength(2);
  expect(sockets).toHaveLength(0);
});

test('a later authoritative payout correction is recorded separately from its first result', () => {
  const history = createKalshiMarketHistory();
  const input = {
    receivedAt: time,
    rawPayload: createMarketMetadata({
      status: 'finalized',
      result: 'yes',
      settlement_value_dollars: '1.0000',
    }),
  };
  const first = history.apply(input, createSeriesMetadata());
  const second = history.apply(
    {
      receivedAt: time + 1000,
      rawPayload: { ...input.rawPayload, settlement_value_dollars: '0.5000' },
    },
    createSeriesMetadata(),
  );
  expect(first.market.finalOutcome.payoutDollars).toBe('1.0000');
  expect(second.market.finalOutcome).toMatchObject({
    payoutDollars: '0.5000',
    observedAt: time + 1000,
  });
  expect(second.market.firstSeenAt).toBe(time);
});

test('batched storage preserves row order and rejects a nonconsecutive batch before acknowledging any row', async () => {
  const directory = await newDirectory();
  const store = await createKalshiRecordingStore({ directory, now: () => time });
  const row = (ordinal) => ({
    schemaVersion: 'kalshi-market-recording-v1',
    ordinal,
    synthetic: true,
  });
  await store.appendBatch([row(1), row(2), row(3)]);
  expect((await store.getStatus()).recordCount).toBe(3);
  await store.close();
  const saved = [];
  for await (const { record } of readKalshiArchive(directory)) saved.push(record.ordinal);
  expect(saved).toEqual([1, 2, 3]);
  const invalid = await createKalshiRecordingStore({
    directory: await newDirectory(),
    now: () => time,
  });
  await expect(invalid.appendBatch([row(1), row(3)])).rejects.toThrow(/consecutive/);
  expect((await invalid.getStatus()).recordCount).toBe(0);
  expect((await invalid.close()).complete).toBe(false);
});
