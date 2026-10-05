/** @jest-environment node */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gzipSync } from 'node:zlib';
import { createAdvisorForecast } from '../utils/advisorForecast.utils';
import { START, contract, bookAt } from './TradingAdvisor.fixtures';

const NOW = contract.expiresAt - 6 * 60_000;
const ADVICE_ID = 'historical-test-advice';
const SCRIPT = path.resolve('scripts/research/compare-advisor-forecasts.mjs');
const hash = (payload) => createHash('sha256').update(payload).digest('hex');
let directory;
let databasePath;
let database;
let snapshot;

function createInput() {
  const samples = Array.from({ length: 1201 }, (_, index) => ({
    time: NOW - (1200 - index) * 1000,
    receivedAt: NOW - (1200 - index) * 1000,
    price: 75500 * Math.exp(Math.sin((index - 1200) / 30) * 0.0001),
  }));
  return {
    now: NOW,
    kalshiMarket: {
      ...contract,
      receivedAt: NOW,
      yesBid: 0.913,
      yesAsk: 0.92,
      noBid: 0.08,
      noAsk: 0.087,
    },
    candles: Array.from({ length: 120 }, (_, index) => ({
      time: NOW - (120 - index) * 60_000,
      open: 75500,
      close: index % 2 ? 75550 : 75450,
      high: 75600,
      low: 75400,
      volume: 10,
    })),
    candlesReceivedAt: NOW,
    ticker: { price: 75500, bid: 75499, ask: 75501, time: NOW, receivedAt: NOW, volume: 100 },
    benchmark: { status: 'live', samples, current: samples.at(-1), receivedAt: NOW },
    stream: {
      status: 'disconnected',
      flow: { available: false },
      liquidity: { available: false },
      quality: {},
    },
  };
}

function archiveSnapshot(value) {
  const payload = JSON.stringify(value);
  database
    .prepare('UPDATE advisor_inputs SET payload = ?, content_hash = ? WHERE advice_id = ?')
    .run(gzipSync(payload), hash(payload), ADVICE_ID);
}

function runReport(extra = []) {
  return spawnSync(
    process.execPath,
    [SCRIPT, '--database', databasePath, '--advice', ADVICE_ID, ...extra],
    {
      encoding: 'utf8',
      timeout: 20_000,
      windowsHide: true,
    },
  );
}

beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'advisor-forecast-report-'));
  databasePath = path.join(directory, 'research.db');
  database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE advisor_advice (id TEXT PRIMARY KEY, evaluated_at INTEGER, payload TEXT, content_hash TEXT);
    CREATE TABLE advisor_inputs (advice_id TEXT PRIMARY KEY, encoding TEXT, payload BLOB, content_hash TEXT);
    CREATE TABLE advisor_events (sequence INTEGER PRIMARY KEY, id TEXT, recorded_at INTEGER, payload TEXT, content_hash TEXT);
  `);
  const { researchInputSnapshot, ...forecast } = createAdvisorForecast(createInput(), {}, START);
  snapshot = researchInputSnapshot;
  const adviceTime = NOW + 100;
  const adviceBook = {
    ...bookAt(adviceTime),
    yesAsks: [{ price: 0.63, quantity: 100 }],
    noAsks: [{ price: 0.38, quantity: 100 }],
  };
  const advice = {
    id: ADVICE_ID,
    policyId: 'historical-test-policy',
    evaluatedAt: adviceTime,
    contract,
    forecast,
    book: adviceBook,
  };
  const adviceJson = JSON.stringify(advice);
  database
    .prepare('INSERT INTO advisor_advice VALUES (?, ?, ?, ?)')
    .run(ADVICE_ID, adviceTime, adviceJson, hash(adviceJson));
  const snapshotJson = JSON.stringify(snapshot);
  database
    .prepare('INSERT INTO advisor_inputs VALUES (?, ?, ?, ?)')
    .run(ADVICE_ID, 'gzip-json', gzipSync(snapshotJson), hash(snapshotJson));
  const executionTime = NOW + 3000;
  const execution = {
    id: `${ADVICE_ID}:execution`,
    adviceId: ADVICE_ID,
    policyId: advice.policyId,
    kind: 'fill',
    contract,
    recordedAt: executionTime,
    book: {
      ...bookAt(executionTime),
      yesAsks: [{ price: 0.65, quantity: 100 }],
      noAsks: [{ price: 0.36, quantity: 100 }],
    },
  };
  const executionJson = JSON.stringify(execution);
  database
    .prepare('INSERT INTO advisor_events VALUES (?, ?, ?, ?, ?)')
    .run(1, execution.id, executionTime, executionJson, hash(executionJson));
});

afterEach(() => {
  database?.close();
  if (
    directory &&
    path.dirname(directory) === path.resolve(tmpdir()) &&
    path.basename(directory).startsWith('advisor-forecast-report-')
  )
    rmSync(directory, { recursive: true });
});

test('audits archived inputs against each saved book without rewriting the database or exporting full inputs', () => {
  const before = hash(readFileSync(databasePath));
  const result = runReport();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report).toMatchObject({
    mode: 'historical-book-substitution',
    snapshot: { adviceId: ADVICE_ID, replayMatched: true, originalCapturedAt: NOW },
    original: { available: true, aboveProbability: 0.99 },
    bookSubstitutions: [
      { role: 'advice-book', marketProbability: 0.625, elapsedSinceOriginalMs: 100 },
      { role: 'execution-book', marketProbability: 0.645, elapsedSinceOriginalMs: 3000 },
    ],
  });
  expect(report.original.marketProbability).toBeCloseTo(0.9165, 10);
  expect(report.bookSubstitutions[0].marketBlend.rawAboveProbability).toBeLessThan(
    report.original.marketBlend.rawAboveProbability,
  );
  expect(report.warning).toContain('not a current-input recomputation');
  expect(report.warning).toContain('does not establish a stale-data bug');
  expect(result.stdout).not.toMatch(/yesAsks|noAsks|researchInputSnapshot|"samples"|"candles"/);
  expect(hash(readFileSync(databasePath))).toBe(before);
});

test('the sequence cutoff excludes a later execution from the historical report', () => {
  const result = runReport(['--max-sequence', '0']);
  expect(result.status).toBe(0);
  const report = JSON.parse(result.stdout);
  expect(report.bookSubstitutions).toHaveLength(1);
  expect(report.bookSubstitutions[0].role).toBe('advice-book');
});

test('rejects a tampered compressed archive before interpreting its contents', () => {
  database
    .prepare('UPDATE advisor_inputs SET payload = ? WHERE advice_id = ?')
    .run(gzipSync('{"tampered":true}'), ADVICE_ID);
  const result = runReport();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain('integrity check');
  expect(result.stdout).toBe('');
});

test.each([
  [
    'later outcome',
    (saved) => {
      saved.input.outcome = 1;
    },
    'not a contemporaneous prediction input',
  ],
  [
    'different research generation',
    (saved) => {
      saved.expectedExperiment.version = 'kalshi-ablation-v4';
    },
    'current research generation',
  ],
  [
    'changed prediction',
    (saved) => {
      saved.expectedExperiment.production.aboveProbability = 0.9;
    },
    'replay differs',
  ],
])('rejects %s instead of turning it into historical forecast evidence', (label, change, error) => {
  change(snapshot);
  archiveSnapshot(snapshot);
  const result = runReport();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain(error);
  expect(result.stdout).toBe('');
});

test('limits decompression of an oversized snapshot', () => {
  const payload = 'x'.repeat(2 * 1024 * 1024 + 1);
  database
    .prepare('UPDATE advisor_inputs SET payload = ?, content_hash = ? WHERE advice_id = ?')
    .run(gzipSync(payload), hash(payload), ADVICE_ID);
  const result = runReport();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toMatch(/2097152|2_097_152/);
  expect(result.stdout).toBe('');
});
