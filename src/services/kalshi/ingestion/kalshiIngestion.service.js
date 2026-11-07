import 'server-only';
import { isDeepStrictEqual } from 'node:util';
import { fetchKalshiResource } from '../kalshi.transport';
import { hasKalshiCredentials } from '../kalshi.auth';
import { parseKalshiSeries } from '../kalshi.validation';
import { createKalshiBenchmarkStream } from '../benchmarkStream/benchmarkStream.service';
import { createKalshiBookStream } from './kalshiBookStream.service';
import { createKalshiIngestionState } from './kalshiIngestionState.utils';
import {
  createKalshiRecordingStore,
  readKalshiArchive,
  getKalshiRecordingStatus,
} from '../recording/kalshiRecording.repository';

const schemaVersion = 'kalshi-market-recording-v1';
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0;

const restore = async (rows, state, configuration) => {
  let count = 0;
  for await (const { record } of rows) {
    if (
      record.schemaVersion !== schemaVersion ||
      !isDeepStrictEqual(record.configuration, configuration)
    )
      throw new Error('Archive normalization settings differ; use a separate capture directory.');
    if (!isDeepStrictEqual(state.apply(record.input), record.normalized))
      throw new Error(`Kalshi replay diverged at record ${record.ordinal}.`);
    count += 1;
  }
  return count;
};

export const inspectKalshiArchive = async (directory, { now = Date.now } = {}) => {
  let state = null;
  let configuration = null;
  let recordCount = 0;
  for await (const { record } of readKalshiArchive(directory)) {
    if (!state) {
      configuration = record.configuration;
      state = createKalshiIngestionState(configuration);
    }
    recordCount += await restore([{ record }], state, configuration);
  }
  return {
    replayVerified: true,
    recordCount,
    storage: await getKalshiRecordingStatus(directory),
    snapshot: state?.getReport(now()) ?? null,
  };
};

/** One read-only session. Disk acknowledgement is ordered; bounded intake fails closed. */
export const createKalshiRecorder = async ({
  directory,
  freshnessMs = 5000,
  horizonMs = 3 * 60 * 60_000,
  maxBytes = 256 * 1024 * 1024,
  maxPendingRecords = 5000,
  maxPendingBytes = 64 * 1024 * 1024,
  now = Date.now,
  getEnvironment = () => process.env,
  request = fetchKalshiResource,
  createStore = createKalshiRecordingStore,
  createBookStream = createKalshiBookStream,
  createReferenceStream = createKalshiBenchmarkStream,
} = {}) => {
  if (
    ![freshnessMs, horizonMs, maxBytes, maxPendingRecords, maxPendingBytes].every(positiveInteger)
  )
    throw new Error('Capture limits must be positive safe integers.');
  const configuration = { freshnessMs };
  const store = await createStore({ directory, maxBytes, now });
  const state = createKalshiIngestionState(configuration);
  try {
    await restore(store.readPriorArchive(), state, configuration);
  } catch (error) {
    await store.close({ complete: false, error: 'Restore failed.' });
    throw error;
  }
  let accepting = true;
  let started = false;
  let stopped = false;
  let failure = null;
  let failureCode = null;
  let ordinal = 0;
  let writtenRecords = 0;
  let storageFailed = false;
  let pending = Promise.resolve();
  const queue = [];
  let draining = false;
  let pendingRecords = 0;
  let pendingBytes = 0;
  let peakPendingRecords = 0;
  let peakPendingBytes = 0;
  let bookStream = null;
  let referenceStream = null;
  let subscribedTickers = [];
  let polling = null;
  let stopping = null;
  let lastReferenceStatus = null;

  const fail = (code = 'capture_failed') => {
    if (failure) return;
    failureCode = code;
    failure = new Error(
      `Kalshi capture is incomplete (${code}); inspect storage and queue limits.`,
    );
    accepting = false;
    bookStream?.stop();
    referenceStream?.stop();
  };
  const drain = () => {
    if (draining) return;
    draining = true;
    pending = (async () => {
      while (queue.length) {
        const batch = queue.splice(0, 100);
        try {
          if (!storageFailed) {
            if (store.appendBatch) {
              await store.appendBatch(batch.map((entry) => entry.row));
              writtenRecords += batch.length;
            } else
              for (const { row } of batch) {
                await store.append(row);
                writtenRecords += 1;
              }
          }
        } catch {
          storageFailed = true;
          fail('storage_append_failed');
        } finally {
          pendingRecords -= batch.length;
          pendingBytes -= batch.reduce((total, entry) => total + entry.bytes, 0);
        }
      }
    })().finally(() => {
      draining = false;
      if (queue.length) drain();
    });
  };
  const capture = (input) => {
    if (!accepting) return;
    try {
      const serialized = JSON.stringify(input);
      const bytes = Buffer.byteLength(serialized);
      if (pendingRecords >= maxPendingRecords || pendingBytes + bytes > maxPendingBytes) {
        fail('pending_queue_limit');
        return;
      }
      const copied = JSON.parse(serialized);
      const normalized = state.apply(copied);
      ordinal += 1;
      const row = { schemaVersion, ordinal, configuration, input: copied, normalized };
      pendingRecords += 1;
      pendingBytes += bytes;
      peakPendingRecords = Math.max(peakPendingRecords, pendingRecords);
      peakPendingBytes = Math.max(peakPendingBytes, pendingBytes);
      queue.push({ row, bytes });
      drain();
      if (input.kind === 'book-frame' && state.requiresResync()) bookStream?.requestSnapshot();
    } catch {
      fail('capture_normalization_failed');
    }
  };
  const read = async (resourcePath, kind, extra = {}) => {
    if (!accepting || stopped) return null;
    try {
      const rawPayload = await request(resourcePath);
      capture({
        kind,
        rawPayload: kind === 'benchmark-rest' ? JSON.stringify(rawPayload) : rawPayload,
        resourcePath,
        receivedAt: now(),
        ...extra,
      });
      return rawPayload;
    } catch (error) {
      capture({
        kind: 'read-error',
        resourcePath,
        status: error.status ?? null,
        receivedAt: now(),
      });
      return null;
    }
  };
  const referenceStatus = (status, reason = null) => {
    const key = JSON.stringify({ status, reason });
    if (key === lastReferenceStatus) return;
    lastReferenceStatus = key;
    capture({ kind: 'reference-status', status, reason, receivedAt: now() });
  };
  const pollOnce = async () => {
    const seriesPayload = await read('/series/KXBTC15M', 'series');
    if (!seriesPayload || !accepting || stopped) return;
    const series = parseKalshiSeries(seriesPayload);
    const tracked = state
      .getMarkets()
      .filter((market) => !market.finalOutcome)
      .map((market) => market.ticker);
    for (const status of ['open', 'unopened']) {
      if (!accepting || stopped) return;
      let cursor = '';
      const cursors = new Set();
      for (let page = 0; ; page += 1) {
        if (page >= 100)
          throw new Error('Market discovery exceeded its page limit; completeness is unknown.');
        const query = new URLSearchParams({
          series_ticker: 'KXBTC15M',
          status,
          limit: '100',
          exchange_index: String(series.exchangeIndex),
        });
        if (cursor) query.set('cursor', cursor);
        const response = await read(`/markets?${query}`, 'market-page', { horizonMs });
        if (!response || !accepting || stopped) break;
        if (!Array.isArray(response.markets)) throw new Error('Invalid market discovery response.');
        cursor = response.cursor ?? '';
        if (!cursor) break;
        if (typeof cursor !== 'string' || cursors.has(cursor))
          throw new Error('Invalid or repeated discovery cursor.');
        cursors.add(cursor);
      }
    }
    // Keep following previously seen contracts after discovery no longer returns them.
    for (const ticker of tracked) {
      if (!accepting || stopped) return;
      const resourcePath = `/markets/${ticker}`;
      try {
        const rawPayload = await request(resourcePath);
        capture({ kind: 'market', rawPayload, resourcePath, receivedAt: now() });
      } catch (error) {
        if (error.status === 404) await read(`/historical/markets/${ticker}`, 'market');
        else
          capture({
            kind: 'read-error',
            resourcePath,
            status: error.status ?? null,
            receivedAt: now(),
          });
      }
    }
    if (!accepting || stopped) return;
    const tickers = state
      .getMarkets()
      .filter(
        (market) =>
          !market.finalOutcome &&
          ['active', 'open'].includes(market.lifecycle.state) &&
          market.lifecycle.tradingClosesAt > now(),
      )
      .map((market) => market.ticker)
      .sort();
    if (!isDeepStrictEqual(tickers, subscribedTickers)) {
      bookStream?.stop();
      subscribedTickers = tickers;
      capture({ kind: 'book-reset', tickers, receivedAt: now() });
      bookStream = tickers.length
        ? createBookStream({ tickers, onCapture: capture, now, getEnvironment })
        : null;
      bookStream?.start();
    }
    for (const ticker of tickers)
      await read(`/markets/${ticker}/orderbook?depth=100`, 'book-rest', { ticker });
    if (!accepting || stopped) return;
    if (hasKalshiCredentials(getEnvironment())) {
      try {
        const resourcePath = '/cfbenchmarks/values?id=BRTI&maxResolution=PER_SECOND';
        const payload = await request(resourcePath);
        capture({
          kind: 'benchmark-rest',
          rawPayload: JSON.stringify(payload),
          resourcePath,
          receivedAt: now(),
        });
        referenceStatus(
          'rest-access-confirmed',
          'Access succeeded; availability still requires a valid fresh BRTI value.',
        );
      } catch (error) {
        referenceStatus(
          [401, 403].includes(error.status) ? 'unauthorized' : 'unavailable',
          [401, 403].includes(error.status)
            ? 'Kalshi credentials or BRTI entitlement were denied.'
            : 'Official BRTI could not be read; source-agency outage is not established.',
        );
      }
    } else
      referenceStatus(
        'not-configured',
        'Official BRTI needs server credentials and account entitlement.',
      );
  };
  const poll = () => {
    if (!accepting || stopped) return Promise.resolve();
    if (polling) return polling;
    polling = pollOnce()
      .catch(() => {
        capture({
          kind: 'read-error',
          resourcePath: 'discovery-cycle',
          status: null,
          receivedAt: now(),
        });
      })
      .finally(() => {
        polling = null;
      });
    return polling;
  };
  const getStatus = async () => {
    await pending;
    return {
      state: failure ? 'failed' : stopped ? 'stopped' : started ? 'recording' : 'ready',
      error: failure?.message ?? null,
      failureCode,
      location: store.location,
      captureSequence: store.captureSequence,
      writtenRecords,
      receivedRecords: ordinal,
      unpersistedRecords: ordinal - writtenRecords,
      pendingRecords,
      pendingBytes,
      peakPendingRecords,
      peakPendingBytes,
      queueLimits: { maxPendingRecords, maxPendingBytes },
      snapshot: state.getReport(now(), { recording: started && !stopped && !failure }),
      storage: await store.getStatus(),
    };
  };
  const start = async () => {
    if (started || stopped) throw new Error('A capture session can only start once.');
    started = true;
    if (hasKalshiCredentials(getEnvironment())) {
      referenceStream = createReferenceStream({
        now,
        getEnvironment,
        onCapture: capture,
        onUpdate: () => {
          const status = referenceStream?.getStatus();
          if (status) referenceStatus(status.status, status.reason);
        },
      });
      referenceStream.start();
    }
    await poll();
  };
  const stop = () => {
    if (stopping) return stopping;
    stopping = (async () => {
      stopped = true;
      await polling;
      bookStream?.stop();
      referenceStream?.stop();
      capture({ kind: 'capture-stopped', receivedAt: now() });
      accepting = false;
      while (draining) await pending;
      await store.close({ complete: !failure, error: failure?.message ?? null });
      if (failure) throw failure;
      return getStatus();
    })();
    return stopping;
  };
  return { start, poll, stop, getStatus };
};
