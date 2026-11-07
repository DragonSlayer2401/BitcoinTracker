import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import {
  createSpotRecorder,
  replaySpotRecording,
} from '../src/services/coinbase/recording/spotRecording.service';
import {
  getSpotRecordingStatus,
  pruneSpotRecordings,
} from '../src/services/coinbase/recording/spotRecording.repository';

const help = `Record one public Coinbase Exchange BTC-USD spot feed. No credentials or trading.

pnpm spot:capture record [--directory PATH] [--duration-seconds N] [--json]
  [--retention-hours N] [--max-bytes N] [--freshness-ms N]
  [--max-pending-records N] [--max-pending-bytes N]
pnpm spot:capture status [--directory PATH] [--json]
pnpm spot:capture replay --file PATH [--json]
pnpm spot:capture prune --retention-hours N [--directory PATH] [--json]

Default directory: data/coinbase-spot. Record until Ctrl+C unless duration is supplied.
Defaults: retention disabled (0 hours); total raw archive cap 256 MiB; freshness 5000 ms;
pending queue cap 1000 records / 64 MiB. These are configurable local operating limits.
Retention is reported, not automatic: prune explicitly removes only expired completed
captures owned by this recorder. Active/incomplete captures are retained. The byte cap
stops capture; it never silently discards observations or prunes research/account data.
Replay verifies normalized output without network access or changing the recording.
`;

const readInteger = (value, name, fallback, minimum = 1) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum)
    throw new Error(`--${name} must be an integer at least ${minimum}.`);
  return Number(value);
};

export const parseSpotCaptureArguments = (args) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      directory: { type: 'string' },
      file: { type: 'string' },
      'duration-seconds': { type: 'string' },
      'retention-hours': { type: 'string' },
      'max-bytes': { type: 'string' },
      'freshness-ms': { type: 'string' },
      'max-pending-records': { type: 'string' },
      'max-pending-bytes': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || (positionals.length === 0 && Object.keys(values).length === 0))
    return { command: 'help' };
  const command = positionals[0];
  if (positionals.length !== 1 || !['record', 'status', 'replay', 'prune'].includes(command))
    throw new Error('Choose record, status, replay, or prune. Use --help for syntax.');
  const allowed = {
    record: [
      'directory',
      'duration-seconds',
      'retention-hours',
      'max-bytes',
      'freshness-ms',
      'max-pending-records',
      'max-pending-bytes',
      'json',
    ],
    status: ['directory', 'json'],
    replay: ['file', 'json'],
    prune: ['directory', 'retention-hours', 'json'],
  };
  for (const name of Object.keys(values))
    if (!allowed[command].includes(name)) throw new Error(`--${name} is not valid for ${command}.`);
  if (command === 'replay' && !values.file) throw new Error('replay requires --file.');
  if (command === 'prune' && values['retention-hours'] === undefined)
    throw new Error('prune requires an explicit positive --retention-hours.');
  return {
    command,
    json: values.json === true,
    directory: path.resolve(values.directory ?? 'data/coinbase-spot'),
    ...(values.file ? { filename: path.resolve(values.file) } : {}),
    durationSeconds: readInteger(values['duration-seconds'], 'duration-seconds', null),
    retentionHours: readInteger(
      values['retention-hours'],
      'retention-hours',
      0,
      command === 'prune' ? 1 : 0,
    ),
    maxBytes: readInteger(values['max-bytes'], 'max-bytes', 256 * 1024 * 1024),
    freshnessMs: readInteger(values['freshness-ms'], 'freshness-ms', 5000),
    maxPendingRecords: readInteger(values['max-pending-records'], 'max-pending-records', 1000),
    maxPendingBytes: readInteger(
      values['max-pending-bytes'],
      'max-pending-bytes',
      64 * 1024 * 1024,
    ),
  };
};

const summarizeObservation = (observation) => {
  if (!observation) return null;
  const { bids, asks, changes, ...summary } = observation;
  return {
    ...summary,
    ...(bids ? { bidLevels: bids.length } : {}),
    ...(asks ? { askLevels: asks.length } : {}),
    ...(changes ? { changedLevels: changes.length } : {}),
  };
};

const writeReport = (report, json, write) => {
  const summary = report.snapshot
    ? {
        ...report,
        snapshot: {
          ...report.snapshot,
          latestObservation: summarizeObservation(report.snapshot.latestObservation),
        },
      }
    : report;
  write(`${JSON.stringify(summary, null, json ? undefined : 2)}\n`);
};

/** Only this command starts a socket. Status, replay and retention are local operations. */
export const runSpotCaptureCommand = async (
  args,
  {
    signal,
    write = (text) => process.stdout.write(text),
    createRecorder = createSpotRecorder,
    replay = replaySpotRecording,
    readStatus = getSpotRecordingStatus,
    prune = pruneSpotRecordings,
    now = Date.now,
  } = {},
) => {
  const options = parseSpotCaptureArguments(args);
  if (options.command === 'help') {
    write(help);
    return;
  }
  if (options.command === 'status') {
    const report = await readStatus(options.directory);
    writeReport(report, options.json, write);
    return report;
  }
  if (options.command === 'replay') {
    const report = await replay(options.filename);
    writeReport(report, options.json, write);
    return report;
  }
  if (options.command === 'prune') {
    const report = await prune({
      directory: options.directory,
      retentionHours: options.retentionHours,
    });
    writeReport(report, options.json, write);
    return report;
  }
  const recorder = await createRecorder({ ...options, WebSocketImpl: WebSocket, now });
  const startedAt = now();
  let nextReportAt = startedAt;
  try {
    recorder.start();
    while (
      !signal?.aborted &&
      (options.durationSeconds === null || now() - startedAt < options.durationSeconds * 1000)
    ) {
      const report = await recorder.getStatus();
      if (report.state === 'failed')
        throw new Error(report.error ?? 'Recording stopped after a capture failure.');
      if (now() >= nextReportAt) {
        writeReport(report, options.json, write);
        nextReportAt = now() + 5000;
      }
      await delay(250, undefined, { signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    }
    const report = await recorder.stop();
    writeReport(report, options.json, write);
    return report;
  } catch (error) {
    await recorder.stop().catch(() => {});
    throw error;
  }
};
