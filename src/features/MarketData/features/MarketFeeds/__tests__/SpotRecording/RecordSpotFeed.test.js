/** @jest-environment node */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createSpotRecorder,
  replaySpotRecording,
} from '@/services/coinbase/recording/spotRecording.service';
import {
  createSpotRecordingStore,
  readSpotRecording,
} from '@/services/coinbase/recording/spotRecording.repository';

const initialTime = Date.UTC(2026, 10, 7, 12);
let directories;
let recorders;
let sockets;

class FakeWebSocket {
  readyState = 0;
  sent = [];
  constructor() {
    sockets.push(this);
  }
  send = (payload) => this.sent.push(payload);
  open = () => {
    this.readyState = 1;
    this.onopen?.();
  };
  message = (payload) => this.onmessage?.({ data: payload });
  close = () => {
    this.readyState = 3;
  };
  disconnect = () => {
    this.readyState = 3;
    this.onclose?.();
  };
}

const subscriptions = JSON.stringify({
  type: 'subscriptions',
  channels: ['matches', 'heartbeat', 'ticker', 'level2_batch'].map((name) => ({
    name,
    product_ids: ['BTC-USD'],
  })),
});
const heartbeat = (time, tradeId = 100) =>
  JSON.stringify({
    type: 'heartbeat',
    product_id: 'BTC-USD',
    time: new Date(time).toISOString(),
    last_trade_id: tradeId,
  });
const ticker = (time, overrides = {}) =>
  JSON.stringify({
    type: 'ticker',
    product_id: 'BTC-USD',
    sequence: 1000,
    trade_id: 100,
    time: new Date(time).toISOString(),
    price: '50000.12000000',
    best_bid: '50000.11',
    best_ask: '50000.13',
    volume_24h: '12.34567890',
    ...overrides,
  });

const createRecorder = async (options = {}) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bitcoin-spot-recorder-'));
  directories.push(directory);
  const recorder = await createSpotRecorder({
    directory,
    WebSocketImpl: FakeWebSocket,
    random: () => 0,
    ...options,
  });
  recorders.push(recorder);
  return recorder;
};
const waitForWrites = async (recorder) => {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const status = await recorder.getStatus();
    if (status.pendingRecords === 0 || status.state === 'failed') return status;
  }
  throw new Error('Fixture writes did not finish.');
};
const readRows = async (filename) => {
  const rows = [];
  for await (const row of readSpotRecording(filename)) rows.push(row);
  return rows;
};
const startLiveFixture = (recorder) => {
  recorder.start();
  const socket = sockets.at(-1);
  socket.open();
  socket.message(subscriptions);
  socket.message(heartbeat(Date.now()));
  socket.message(ticker(Date.now()));
  return socket;
};

beforeEach(() => {
  directories = [];
  recorders = [];
  sockets = [];
  jest.useFakeTimers({ now: initialTime, doNotFake: ['nextTick', 'setImmediate'] });
});

afterEach(async () => {
  for (const recorder of recorders) await recorder.stop().catch(() => {});
  jest.useRealTimers();
  for (const directory of directories) {
    const target = path.resolve(directory);
    if (
      path.dirname(target) !== path.resolve(os.tmpdir()) ||
      !path.basename(target).startsWith('bitcoin-spot-recorder-')
    )
      throw new Error('Refusing to remove a directory outside this test fixture.');
    await rm(target, { recursive: true, force: true });
  }
});

test('record, stop, and replay preserve every raw frame and exact normalized output in receipt order', async () => {
  const recorder = await createRecorder();
  const socket = startLiveFixture(recorder);
  const repeated = ticker(initialTime);
  socket.message(repeated);
  const status = await waitForWrites(recorder);
  expect({ state: status.state, error: status.error, reason: status.snapshot.reason }).toEqual({
    state: 'recording',
    error: null,
    reason: null,
  });
  expect(status.snapshot).toMatchObject({
    available: true,
    source: { kind: 'proxy' },
    latestQuote: { price: '50000.12000000', receivedAt: initialTime, time: initialTime },
  });
  const stopped = await recorder.stop();
  expect(stopped).toMatchObject({
    state: 'stopped',
    pendingRecords: 0,
    storage: { complete: true },
  });
  const rows = await readRows(recorder.location);
  expect(rows.map((row) => row.ordinal)).toEqual(rows.map((_row, index) => index + 1));
  expect(rows.filter((row) => row.input.payload === repeated)).toHaveLength(2);
  expect(rows.filter((row) => row.normalized.disposition === 'duplicate')).toHaveLength(1);
  expect(rows.at(-1).input).toMatchObject({ kind: 'connection', state: 'stopped' });
  const replayed = [];
  const replay = await replaySpotRecording(recorder.location, {
    onRecord: (row) => replayed.push(row),
  });
  expect(replayed).toEqual(rows);
  expect(replay).toMatchObject({
    recordCount: rows.length,
    configuration: { freshnessMs: 5000 },
    snapshot: { available: false, latestQuote: null },
  });
});

test('disconnects invalidate the current quote and reconnection evidence is replayable', async () => {
  const recorder = await createRecorder();
  const socket = startLiveFixture(recorder);
  await waitForWrites(recorder);
  socket.disconnect();
  expect((await waitForWrites(recorder)).snapshot).toMatchObject({
    available: false,
    latestQuote: null,
  });
  jest.advanceTimersByTime(1000);
  const replacement = sockets.at(-1);
  expect(replacement).not.toBe(socket);
  replacement.open();
  replacement.message(subscriptions);
  replacement.message(heartbeat(Date.now(), 200));
  replacement.message(ticker(Date.now(), { sequence: 2000, trade_id: 200 }));
  expect((await waitForWrites(recorder)).snapshot.available).toBe(true);
  jest.setSystemTime(Date.now() + 6000);
  expect((await recorder.getStatus()).snapshot).toMatchObject({
    available: false,
    latestQuote: null,
  });
  await recorder.stop();
  const rows = await readRows(recorder.location);
  expect(rows.some((row) => row.normalized.gaps.some((gap) => gap.kind === 'disconnect'))).toBe(
    true,
  );
  await expect(replaySpotRecording(recorder.location)).resolves.toMatchObject({
    recordCount: rows.length,
  });
});

test('stop waits for accepted disk writes even when the data queue is full', async () => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const recorder = await createRecorder({
    maxPendingRecords: 1,
    createStore: async (options) => {
      const store = await createSpotRecordingStore(options);
      return {
        ...store,
        append: async (row) => {
          await held;
          return store.append(row);
        },
      };
    },
  });
  recorder.start();
  let completed = false;
  const stopping = recorder.stop().then((status) => {
    completed = true;
    return status;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  release();
  expect(await stopping).toMatchObject({
    state: 'stopped',
    writtenRecords: 2,
    storage: { complete: true },
  });
  await expect(replaySpotRecording(recorder.location)).resolves.toMatchObject({ recordCount: 2 });
});

test.each([{ maxPendingRecords: 2 }, { maxPendingBytes: 150 }])(
  'a bounded queue overflow stops capture and never reports a current quote (%j)',
  async (limits) => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const recorder = await createRecorder({
      ...limits,
      createStore: async (options) => {
        const store = await createSpotRecordingStore(options);
        return {
          ...store,
          append: async (row) => {
            await held;
            return store.append(row);
          },
        };
      },
    });
    recorder.start();
    const socket = sockets.at(-1);
    socket.open();
    socket.message(subscriptions);
    expect(await recorder.getStatus()).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('queue overflow'),
      snapshot: { available: false, latestObservation: null, latestQuote: null },
    });
    expect(socket.readyState).toBe(3);
    release();
    await expect(recorder.stop()).rejects.toThrow('queue overflow');
    expect((await recorder.getStatus()).storage.complete).toBe(false);
    await expect(replaySpotRecording(recorder.location)).rejects.toThrow('completed capture');
  },
);

test('an actual archive byte-limit failure is visible and keeps the capture incomplete', async () => {
  const recorder = await createRecorder({ maxBytes: 1 });
  recorder.start();
  const status = await waitForWrites(recorder);
  expect(status.state).toBe('failed');
  expect(status.snapshot).toMatchObject({ available: false, latestQuote: null });
  await expect(recorder.stop()).rejects.toThrow('byte limit');
  expect((await recorder.getStatus()).storage.complete).toBe(false);
  await expect(replaySpotRecording(recorder.location)).rejects.toThrow('completed capture');
});

test('replay refuses normalized evidence that no longer matches the original inputs', async () => {
  const recorder = await createRecorder();
  startLiveFixture(recorder);
  await recorder.stop();
  const original = await readFile(recorder.location, 'utf8');
  const tampered = original.replace('"disposition":"accepted"', '"disposition":"rejected"');
  expect(Buffer.byteLength(tampered)).toBe(Buffer.byteLength(original));
  expect(tampered).not.toBe(original);
  await writeFile(recorder.location, tampered, 'utf8');
  await expect(replaySpotRecording(recorder.location)).rejects.toThrow(
    'Normalized replay mismatch',
  );
});
