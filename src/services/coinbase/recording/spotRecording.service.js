import { isDeepStrictEqual } from 'node:util';
import { createCoinbaseStream } from '../stream/coinbaseStream.service.js';
import { createCoinbaseSpotNormalizer } from './coinbaseSpotNormalizer.utils.js';
import { createSpotRecordingStore, readSpotRecording } from './spotRecording.repository.js';

const schemaVersion = 'coinbase-spot-recording-v1';
const isPositiveInteger = (value) => Number.isSafeInteger(value) && value > 0;
const asError = (error) => (error instanceof Error ? error : new Error(String(error)));

/** Records received input in order; the bounded queue fails closed instead of dropping evidence. */
export const createSpotRecorder = async ({
  directory,
  retentionHours = 0,
  maxBytes = 256 * 1024 * 1024,
  maxPendingRecords = 1000,
  maxPendingBytes = 64 * 1024 * 1024,
  freshnessMs = 5000,
  WebSocketImpl = globalThis.WebSocket,
  now = Date.now,
  random = Math.random,
  createStore = createSpotRecordingStore,
  createStream = createCoinbaseStream,
} = {}) => {
  if (![maxPendingRecords, maxPendingBytes, freshnessMs].every(isPositiveInteger))
    throw new TypeError('Recording queue limits and freshnessMs must be positive safe integers.');
  const store = await createStore({ directory, retentionHours, maxBytes, now });
  const normalizer = createCoinbaseSpotNormalizer({ freshnessMs });
  const configuration = { freshnessMs };
  let state = 'ready';
  let failure = null;
  let stream = null;
  let accepting = false;
  let queue = [];
  let pendingBytes = 0;
  let receivedRecords = 0;
  let writtenRecords = 0;
  let draining = null;
  let stopping = null;
  let terminalCaptureQueued = false;

  const fail = (error) => {
    if (failure) return;
    failure = asError(error);
    state = 'failed';
    accepting = false;
    try {
      stream?.stop();
    } catch {
      // The original recording failure remains the cause; no further input is accepted.
    }
    // Keep failure observable via getStatus()/stop(), while closing without unhandled rejection.
    void stop().catch(() => {});
  };

  const drain = () => {
    if (draining || queue.length === 0) return;
    draining = (async () => {
      while (queue.length > 0) {
        const entry = queue[0];
        try {
          const normalized = normalizer.apply(entry.input);
          await store.append({
            schemaVersion,
            ordinal: writtenRecords + 1,
            configuration,
            input: entry.input,
            normalized,
          });
          writtenRecords += 1;
          queue.shift();
          pendingBytes -= entry.bytes;
        } catch (error) {
          fail(error);
          queue = [];
          pendingBytes = 0;
        }
      }
    })().finally(() => {
      draining = null;
      if (queue.length > 0) drain();
    });
  };

  const capture = (input) => {
    if (!accepting) return;
    try {
      const serialized = JSON.stringify(input);
      const bytes = Buffer.byteLength(serialized, 'utf8');
      // Reserve one small control record so stopping a full data queue can still drain cleanly.
      const isTerminalCapture =
        state === 'stopping' &&
        !terminalCaptureQueued &&
        input.kind === 'connection' &&
        input.state === 'stopped' &&
        bytes <= 1024;
      if (
        !isTerminalCapture &&
        (queue.length >= maxPendingRecords || pendingBytes + bytes > maxPendingBytes)
      ) {
        fail(new Error('Spot recording queue overflow; capture is incomplete.'));
        return;
      }
      if (isTerminalCapture) terminalCaptureQueued = true;
      queue.push({ input: JSON.parse(serialized), bytes });
      pendingBytes += bytes;
      receivedRecords += 1;
      drain();
    } catch (error) {
      fail(error);
    }
  };

  const getStatus = async () => {
    const storage = await store.getStatus();
    const snapshot = normalizer.getSnapshot(now());
    return {
      state,
      error: failure?.message ?? null,
      captureId: store.captureId,
      location: store.location,
      receivedRecords,
      writtenRecords,
      pendingRecords: queue.length,
      pendingBytes,
      snapshot: failure
        ? {
            ...snapshot,
            status: 'unavailable',
            available: false,
            reason: failure.message,
            latestObservation: null,
            latestQuote: null,
          }
        : snapshot,
      storage,
    };
  };

  const start = () => {
    if (state === 'recording') return;
    if (state !== 'ready') throw new Error('A recording session cannot be restarted.');
    accepting = true;
    state = 'recording';
    try {
      stream.start();
    } catch (error) {
      fail(error);
    }
  };

  const stop = () => {
    if (stopping) return stopping;
    stopping = Promise.resolve().then(async () => {
      if (!failure) state = 'stopping';
      try {
        // The stopped capture is part of a successful recording, before we close intake.
        stream?.stop();
      } catch (error) {
        fail(error);
      }
      accepting = false;
      while (draining) await draining;
      try {
        await store.close({ complete: failure === null, error: failure?.message ?? null });
      } catch (error) {
        fail(error);
      }
      if (failure) throw failure;
      state = 'stopped';
      return getStatus();
    });
    return stopping;
  };

  try {
    stream = createStream({ onCapture: capture, WebSocketImpl, now, random });
  } catch (error) {
    await store.close({ complete: false, error: asError(error).message });
    throw error;
  }
  return { start, stop, getStatus, location: store.location, captureId: store.captureId };
};

/** Replays a finalized capture using its recorded settings, verifying every normalized output. */
export const replaySpotRecording = async (filename, { onRecord = null } = {}) => {
  let normalizer = null;
  let configuration = null;
  let recordCount = 0;
  let observationCount = 0;
  let lastInput = null;
  const dispositions = {};
  for await (const record of readSpotRecording(filename)) {
    if (record.schemaVersion !== schemaVersion || record.ordinal !== recordCount + 1)
      throw new Error(`Unsupported or out-of-order recording row ${recordCount + 1}.`);
    if (!normalizer) {
      if (
        !record.configuration ||
        Object.keys(record.configuration).length !== 1 ||
        !isPositiveInteger(record.configuration.freshnessMs)
      )
        throw new Error('Recording has no supported normalization configuration.');
      configuration = record.configuration;
      normalizer = createCoinbaseSpotNormalizer(configuration);
    } else if (!isDeepStrictEqual(configuration, record.configuration)) {
      throw new Error(`Normalization configuration changed at row ${record.ordinal}.`);
    }
    const normalized = normalizer.apply(record.input);
    if (!isDeepStrictEqual(normalized, record.normalized))
      throw new Error(`Normalized replay mismatch at row ${record.ordinal}.`);
    recordCount += 1;
    if (normalized.observation) observationCount += 1;
    dispositions[normalized.disposition] = (dispositions[normalized.disposition] ?? 0) + 1;
    lastInput = record.input;
    if (onRecord) await onRecord(record);
  }
  if (!normalizer || lastInput?.kind !== 'connection' || lastInput.state !== 'stopped')
    throw new Error('Recording does not contain a completed stopped session.');
  return {
    schemaVersion,
    location: filename,
    recordCount,
    observationCount,
    dispositions,
    configuration,
    snapshot: normalizer.getSnapshot(lastInput.receivedAt),
  };
};
