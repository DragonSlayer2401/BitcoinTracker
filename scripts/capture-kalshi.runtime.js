import path from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createKalshiRecorder,
  inspectKalshiArchive,
} from '../src/services/kalshi/ingestion/kalshiIngestion.service';

const help = `Read-only KXBTC15M market, order-book and official reference capture.

pnpm kalshi:capture record [--directory PATH] [--duration-seconds N] [--poll-seconds N]
  [--max-bytes N] [--freshness-ms N] [--max-pending-records N] [--max-pending-bytes N] [--json]
pnpm kalshi:capture inspect [--directory PATH] [--json]

Defaults: data/kalshi-market; poll every 30 seconds; quote/reference freshness 5000 ms;
256 MiB archive limit; queue 5000 records / 64 MiB; retention disabled.
These are local operating settings. A full queue stops capture as incomplete.
Record stops on Ctrl+C or duration. Inspect verifies all saved normalized records by replay.
Authenticated books/BRTI require server Kalshi credentials and account/channel entitlement.
REST discovery remains public. Official references are never replaced by exchange proxies.
No orders, forecast inputs, research experiments or account-history writes are performed.
Network reads use the application's shared Kalshi rate-limit store. For an isolated smoke
check set KALSHI_RATE_LIMIT_DATABASE_URL to an isolated file URL before running.
`;
const integer = (value, fallback) => {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) <= 0)
    throw new Error('Capture limits must be positive integers.');
  return Number(value);
};
const summarize = (report) => ({
  ...report,
  snapshot: report.snapshot
    ? {
        ...report.snapshot,
        markets: report.snapshot.markets.map((market) => ({
          ticker: market.ticker,
          eventTicker: market.eventTicker,
          ruleVersion: market.ruleVersion,
          reference: market.reference,
          lifecycle: market.lifecycle,
          finalOutcome: market.finalOutcome,
          firstSeenAt: market.firstSeenAt,
          ruleVerification: market.specification?.verification ?? null,
          contractTermsUrl: market.ruleEvidence.series.contractTermsUrl,
        })),
      }
    : null,
});

export const runKalshiCaptureCommand = async (
  args,
  {
    signal,
    write = (text) => process.stdout.write(text),
    now = Date.now,
    createRecorder = createKalshiRecorder,
    inspect = inspectKalshiArchive,
  } = {},
) => {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      directory: { type: 'string' },
      'duration-seconds': { type: 'string' },
      'poll-seconds': { type: 'string' },
      'max-bytes': { type: 'string' },
      'freshness-ms': { type: 'string' },
      'max-pending-records': { type: 'string' },
      'max-pending-bytes': { type: 'string' },
      json: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.help || positionals.length === 0) {
    write(help);
    return;
  }
  if (positionals.length !== 1 || !['record', 'inspect'].includes(positionals[0]))
    throw new Error('Choose record or inspect.');
  const directory = path.resolve(values.directory ?? 'data/kalshi-market');
  const report = (value) =>
    write(
      `${JSON.stringify(values.json ? value : summarize(value), null, values.json ? undefined : 2)}\n`,
    );
  if (positionals[0] === 'inspect') {
    if (Object.keys(values).some((key) => !['directory', 'json'].includes(key)))
      throw new Error('inspect accepts only --directory and --json.');
    const result = await inspect(directory, { now });
    report(result);
    return result;
  }
  const durationMs = integer(values['duration-seconds'], Infinity) * 1000;
  const pollMs = integer(values['poll-seconds'], 30) * 1000;
  if (pollMs < 1000) throw new Error('Polling must be at least one second apart.');
  const recorder = await createRecorder({
    directory,
    now,
    maxBytes: integer(values['max-bytes'], 256 * 1024 * 1024),
    freshnessMs: integer(values['freshness-ms'], 5000),
    maxPendingRecords: integer(values['max-pending-records'], 5000),
    maxPendingBytes: integer(values['max-pending-bytes'], 64 * 1024 * 1024),
  });
  const startedAt = now();
  try {
    await recorder.start();
    let nextPollAt = now() + pollMs;
    let nextReportAt = 0;
    while (!signal?.aborted && now() - startedAt < durationMs) {
      if (now() >= nextPollAt) {
        await recorder.poll();
        nextPollAt = now() + pollMs;
      }
      if (now() >= nextReportAt) {
        const status = await recorder.getStatus();
        report(status);
        if (status.state === 'failed') throw new Error('Capture failed.');
        nextReportAt = now() + 5000;
      }
      await delay(250, undefined, { signal }).catch((error) => {
        if (error.name !== 'AbortError') throw error;
      });
    }
    const result = await recorder.stop();
    report(result);
    return result;
  } catch (error) {
    await recorder.stop().catch(() => {});
    throw error;
  }
};
