/** @jest-environment node */
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setImmediate as yieldToTasks } from 'node:timers/promises';
import {
  createArchive,
  createCollectorSession,
  contract,
  eventStart,
  eventEnd,
} from './helpers/collectorSession';

jest.mock('server-only', () => ({}));

let directory;
let statePath;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bitcoin-evidence-collector-'));
  statePath = path.join(directory, 'collector.json');
  jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('Persistent collector tests must not open the network.');
  });
});

afterEach(async () => {
  expect(globalThis.fetch).not.toHaveBeenCalled();
  jest.restoreAllMocks();
  // Only remove this test's mkdtemp directory, after verifying its absolute location.
  const resolved = path.resolve(directory);
  expect(path.dirname(resolved)).toBe(path.resolve(tmpdir()));
  expect(path.basename(resolved)).toMatch(/^bitcoin-evidence-collector-/);
  await rm(resolved, { recursive: true, force: true });
});

const readState = async () => JSON.parse(await readFile(statePath, 'utf8'));
const decisions = (archive) =>
  [...archive.evidence.values()].filter((row) => row.event === 'decision');

test('a one-step collector check saves a real checkpoint and reports its limited outcome', async () => {
  const session = createCollectorSession({ statePath });
  const report = await session.run();
  const [decision] = decisions(session.archive);
  expect(decision).toMatchObject({
    event: 'decision',
    cohort: 'kalshi-background',
    checkpointMinutes: 12,
    target: 50_000,
    decision: 'pending',
    inputStatus: 'captured',
    inputObservedAt: eventStart + 180_000,
    referenceSource: 'cf-brti',
  });
  expect(decision.researchInputSnapshot).toBeTruthy();
  expect(decision.aboveProbability).toBeGreaterThan(0.5);
  expect(report.status.evidenceCount).toBe(1);
  expect(report.analysis.replay).toEqual({
    checked: 1,
    matched: 1,
    failed: 0,
    skipped: 0,
    failures: [],
  });
  expect(report.analysis.collectorHealth.counts.knownContracts).toBe(1);
  expect(session.logs.join('\n')).toContain('1 event(s) saved');
  expect(session.logs.join('\n')).toContain('A complete 15-minute outcome was not implied');
  expect(session.logs.join('\n')).toContain('replay 1 matched, 0 failed');
  expect(JSON.parse(await readFile(`${statePath}.comparison.json`, 'utf8'))).toEqual(
    report.analysis,
  );
  expect((await readState()).pendingRows).toEqual([]);
  expect(session.archive.heartbeats.at(-1)).toMatchObject({
    status: 'stopped',
    lastEvidenceAt: session.now(),
    progress: { lastSuccessfulTickAt: session.now(), failureCode: null },
  });
  for (const stream of session.streams) {
    expect(stream.start).toHaveBeenCalledTimes(1);
    expect(stream.stop).toHaveBeenCalledTimes(1);
  }
  expect(await readdir(directory)).not.toContain('collector.json.lock');
});

test.each([
  ['missing snapshot', 'The original input snapshot is missing.'],
  ['mismatched snapshot hash', 'The decision and input hashes do not match.'],
])(
  'a one-step check reports a %s without replacing the saved prediction',
  async (failure, reason) => {
    const archive = createArchive();
    await createCollectorSession({ statePath, archive }).run();
    const originalDecision = decisions(archive)[0];
    const storedSnapshot = archive.snapshots.get(originalDecision.eventId);
    if (failure === 'missing snapshot') archive.snapshots.delete(originalDecision.eventId);
    else
      archive.snapshots.set(originalDecision.eventId, {
        ...storedSnapshot,
        contentHash: '0'.repeat(64),
      });

    const session = createCollectorSession({
      statePath,
      archive,
      startTime: eventStart + 181_000,
      price: 49_900,
    });
    await expect(session.run()).rejects.toThrow('Saved prediction replay failed');
    const report = JSON.parse(await readFile(`${statePath}.comparison.json`, 'utf8'));
    expect(report.replay).toMatchObject({
      matched: 0,
      failed: 1,
      failures: [{ snapshotId: originalDecision.eventId, reason }],
    });
    expect(session.logs.join('\n')).toContain('replay 0 matched, 1 failed');
    expect(decisions(archive)).toEqual([originalDecision]);
    expect(archive.heartbeats.at(-1).status).toBe('error');
    expect(await readdir(directory)).not.toContain('collector.json.lock');

    archive.snapshots.set(originalDecision.eventId, storedSnapshot);
    const recovered = await createCollectorSession({
      statePath,
      archive,
      startTime: eventStart + 182_000,
    }).run();
    expect(recovered.analysis.replay).toMatchObject({ matched: 1, failed: 0, failures: [] });
    expect(decisions(archive)).toEqual([originalDecision]);
  },
);

test('a failed archive analysis read retains the capture and succeeds when the archive recovers', async () => {
  const archive = createArchive();
  archive.repository.getLearningEvidenceRows.mockRejectedValueOnce(
    new Error('Saved evidence is unavailable.'),
  );
  await expect(createCollectorSession({ statePath, archive }).run()).rejects.toThrow(
    'Saved evidence is unavailable.',
  );
  const originalDecision = decisions(archive)[0];
  expect(originalDecision.inputStatus).toBe('captured');
  expect(await readdir(directory)).not.toContain('collector.json.comparison.json');
  const recovered = await createCollectorSession({
    statePath,
    archive,
    startTime: eventStart + 181_000,
    price: 49_900,
  }).run();
  expect(recovered.analysis.replay).toMatchObject({ checked: 1, matched: 1, failed: 0 });
  expect(decisions(archive)).toEqual([originalDecision]);
});

test('restarting at each checkpoint preserves earlier calls and does not duplicate a repeated check', async () => {
  const archive = createArchive();
  const first = createCollectorSession({ statePath, archive });
  await first.run();
  const originalDecision = decisions(archive)[0];
  await createCollectorSession({ statePath, archive, price: 49_900 }).run();
  expect(decisions(archive)).toEqual([originalDecision]);

  for (const minutes of [9, 6, 3, 1]) {
    await createCollectorSession({
      statePath,
      archive,
      startTime: eventEnd - minutes * 60_000,
      price: 49_900,
    }).run();
  }
  expect(decisions(archive).map((row) => row.checkpointMinutes)).toEqual([12, 9, 6, 3, 1]);
  expect(decisions(archive)[0]).toEqual(originalDecision);
  expect(
    decisions(archive)
      .slice(1)
      .every((row) => row.aboveProbability < 0.5),
  ).toBe(true);
  expect(new Set(decisions(archive).map((row) => row.forecastId)).size).toBe(5);
  expect(
    (await readState()).state.markets[0].checkpoints.every((row) => row.status === 'pending'),
  ).toBe(true);
});

test('a late restart records missed checkpoints without reconstructing their earlier inputs', async () => {
  const session = createCollectorSession({ statePath, startTime: eventStart + 360_000 });
  await session.run();
  const rows = decisions(session.archive);
  expect(rows).toHaveLength(2);
  expect(rows[0]).toMatchObject({
    checkpointMinutes: 12,
    decision: 'withheld',
    inputStatus: 'decision-inputs-unavailable',
    inputObservedAt: null,
    aboveProbability: null,
  });
  expect(rows[0].researchInputSnapshot).toBeUndefined();
  expect(rows[1]).toMatchObject({
    checkpointMinutes: 9,
    decision: 'pending',
    inputStatus: 'captured',
  });
});

test('an archive outage retains the exact pending capture and replays it after restart', async () => {
  const archive = createArchive();
  archive.repository.persistEvidenceRows.mockRejectedValueOnce(
    Object.assign(new Error('Archive is locked'), { code: 'SQLITE_BUSY' }),
  );
  const first = createCollectorSession({ statePath, archive });
  await expect(first.run()).rejects.toThrow('Archive is locked');
  const saved = await readState();
  expect(saved.pendingRows).toHaveLength(1);
  const pending = saved.pendingRows[0];
  expect(archive.evidence.size).toBe(0);
  expect(archive.heartbeats.at(-1)).toMatchObject({
    status: 'error',
    progress: { failureCode: 'storage-locked' },
  });

  await createCollectorSession({
    statePath,
    archive,
    startTime: eventStart + 181_000,
    price: 49_900,
  }).run();
  expect(decisions(archive)).toEqual([pending]);
  expect((await readState()).pendingRows).toEqual([]);
  expect(decisions(archive)[0].aboveProbability).toBeGreaterThan(0.5);
  expect(await readdir(directory)).not.toContain('collector.json.lock');
});

test('a continuous collector retries storage within the capture grace and reports recovery', async () => {
  const session = createCollectorSession({ statePath });
  session.archive.repository.persistEvidenceRows.mockRejectedValueOnce(
    Object.assign(new Error('private database path must not reach logs'), { code: 'SQLITE_BUSY' }),
  );
  let ticks = 0;
  await session.run({
    once: false,
    sleep: async () => {
      await yieldToTasks();
      ticks += 1;
      if (ticks === 2) session.controller.abort();
      else session.setTime(session.now() + 1000);
    },
  });
  expect(decisions(session.archive)).toHaveLength(1);
  expect(decisions(session.archive)[0].inputObservedAt).toBe(eventStart + 180_000);
  expect(session.logs.join('\n')).toContain('Research recording failed (storage-locked)');
  expect(session.logs.join('\n')).not.toContain('private database path');
  expect(session.archive.heartbeats.at(-1)).toMatchObject({
    status: 'stopped',
    progress: { failureCode: null },
  });
});

test('an expired contract waits for its official outcome and records all checkpoint outcomes once', async () => {
  const archive = createArchive();
  await createCollectorSession({ statePath, archive }).run();
  const session = createCollectorSession({
    statePath,
    archive,
    startTime: eventEnd,
    price: 49_000,
  });
  let ticks = 0;
  const loadMarket = jest.fn(async () => ({
    ...contract,
    status: 'finalized',
    result: 'yes',
    settlementPrice: 50_010,
    receivedAt: session.now(),
  }));
  await session.run({
    once: false,
    loadMarket,
    sleep: async () => {
      await yieldToTasks();
      ticks += 1;
      if (ticks === 1) {
        expect([...archive.evidence.values()].filter((row) => row.event === 'outcome')).toEqual([]);
        session.setTime(eventEnd + 1000);
      } else session.controller.abort();
    },
  });
  const outcomes = [...archive.evidence.values()].filter((row) => row.event === 'outcome');
  expect(loadMarket).toHaveBeenCalledWith(contract.ticker);
  expect(outcomes).toHaveLength(5);
  expect(
    outcomes.every((row) => row.outcome === 'above' && row.kalshiOutcome.result === 'yes'),
  ).toBe(true);
  expect(outcomes[0]).toMatchObject({ observedPrice: 50_010, observedAt: eventEnd });
  expect((await readState()).state.markets).toEqual([]);
  expect((await readState()).state.completed).toEqual([
    { ticker: contract.ticker, expiresAt: eventEnd },
  ]);
});

test('forward labels use exact future benchmark observations without altering the saved prediction', async () => {
  const archive = createArchive();
  await createCollectorSession({ statePath, archive }).run();
  const originalDecision = decisions(archive)[0];
  const report = await createCollectorSession({
    statePath,
    archive,
    startTime: eventStart + 195_000,
    price: 50_200,
  }).run();
  const labels = [...archive.labels.values()];
  expect(labels).toHaveLength(1);
  expect(labels[0]).toMatchObject({
    snapshotId: originalDecision.eventId,
    capturedAt: eventStart + 180_000,
    dueAt: eventStart + 195_000,
    horizonSeconds: 15,
    status: 'observed',
    reference: { price: 50_100 },
    reading: { price: 50_200, time: eventStart + 195_000 },
  });
  expect(decisions(archive)).toEqual([originalDecision]);
  expect(report.analysis.forwardLabels).toEqual({ total: 1, observed: 1, missing: 0 });
  expect(report.analysis.replay).toMatchObject({ checked: 1, matched: 1, failed: 0 });
  expect(report.analysis.collectorHealth.counts.capturedCheckpoints).toBe(1);
});

test('a failed forward-label upload replays the original reading after a collector restart', async () => {
  const archive = createArchive();
  await createCollectorSession({ statePath, archive }).run();
  archive.repository.persistForwardLabels.mockRejectedValueOnce(
    new Error('Label archive is offline'),
  );
  await expect(
    createCollectorSession({
      statePath,
      archive,
      startTime: eventStart + 195_000,
      price: 50_200,
    }).run(),
  ).rejects.toThrow('Label archive is offline');
  const saved = JSON.parse(await readFile(`${statePath}.forward-labels.json`, 'utf8'));
  expect(saved.pending).toHaveLength(1);
  expect(saved.pending[0].reading.price).toBe(50_200);
  await createCollectorSession({
    statePath,
    archive,
    startTime: eventStart + 196_000,
    price: 49_800,
  }).run();
  expect([...archive.labels.values()]).toEqual(saved.pending);
  expect(JSON.parse(await readFile(`${statePath}.forward-labels.json`, 'utf8')).pending).toEqual(
    [],
  );
});

test('a gap at the exact forward second stays pending instead of borrowing a nearby price', async () => {
  const archive = createArchive();
  await createCollectorSession({ statePath, archive }).run();
  const session = createCollectorSession({ statePath, archive, startTime: eventStart + 195_000 });
  const snapshot = session.streams[2].getSnapshot;
  session.streams[2].getSnapshot = () => {
    const benchmark = snapshot();
    const samples = benchmark.samples.filter((sample) => sample.time !== eventStart + 195_000);
    return { ...benchmark, samples, current: samples.at(-1) };
  };
  await session.run();
  expect(archive.labels.size).toBe(0);
  expect(decisions(archive)).toHaveLength(1);
});

test('a lost state lock stops continuous collection without deleting the new owner lock', async () => {
  const session = createCollectorSession({ statePath });
  const replacement = JSON.stringify({ token: 'replacement-owner' });
  await expect(
    session.run({
      once: false,
      sleep: async () => {
        await yieldToTasks();
        await writeFile(`${statePath}.lock`, replacement);
        session.setTime(session.now() + 1000);
      },
    }),
  ).rejects.toThrow('Collector state ownership changed');
  expect(decisions(session.archive)).toHaveLength(1);
  expect(await readFile(`${statePath}.lock`, 'utf8')).toBe(replacement);
  expect(session.archive.heartbeats.at(-1)).toMatchObject({
    status: 'error',
    progress: { failureCode: 'ownership-lost' },
  });
  for (const stream of session.streams) expect(stream.stop).toHaveBeenCalledTimes(1);
});

test('an unfinished archive write retains ownership after shutdown rather than permitting a competing collector', async () => {
  const session = createCollectorSession({ statePath });
  const saveRows = session.archive.repository.persistEvidenceRows.getMockImplementation();
  let finishWrite;
  session.archive.repository.persistEvidenceRows.mockImplementationOnce(
    (rows) =>
      new Promise((resolve) => {
        finishWrite = async () => resolve(await saveRows(rows));
      }),
  );
  await expect(session.run({ operationTimeoutMs: 20, shutdownTimeoutMs: 20 })).rejects.toThrow(
    'Collector operation timed out',
  );
  expect(session.logs.join('\n')).toContain('Its state lock was retained');
  expect(await readdir(directory)).toContain('collector.json.lock');
  await expect(createCollectorSession({ statePath }).run()).rejects.toThrow(
    'Another collector lock exists',
  );
  for (const stream of session.streams) expect(stream.stop).toHaveBeenCalledTimes(1);

  // Let the original write finish before deleting its isolated directory.
  await finishWrite();
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if ((await readState()).pendingRows.length === 0) break;
    await yieldToTasks();
  }
  expect((await readState()).pendingRows).toEqual([]);
  expect(decisions(session.archive)).toHaveLength(1);
});

test('a damaged state file stops collection without replacing the saved contents', async () => {
  const damaged = '{ interrupted state';
  await writeFile(statePath, damaged);
  const session = createCollectorSession({ statePath });
  await expect(session.run()).rejects.toThrow('Collector state is unreadable');
  expect(await readFile(statePath, 'utf8')).toBe(damaged);
  expect(session.archive.evidence.size).toBe(0);
  expect(session.streams[0].start).not.toHaveBeenCalled();
  expect(session.archive.heartbeats.at(-1).status).toBe('error');
  expect(await readdir(directory)).not.toContain('collector.json.lock');
});

test('another collector lock prevents starting feeds or changing its state', async () => {
  const lock = JSON.stringify({ token: 'another-owner' });
  await writeFile(`${statePath}.lock`, lock);
  const session = createCollectorSession({ statePath });
  await expect(session.run()).rejects.toThrow('Another collector lock exists');
  expect(session.streams[0].start).not.toHaveBeenCalled();
  expect(session.archive.evidence.size).toBe(0);
  expect(await readFile(`${statePath}.lock`, 'utf8')).toBe(lock);
});

test('an unsuccessful smoke check closes feeds and releases ownership for a later retry', async () => {
  const session = createCollectorSession({ statePath });
  await expect(session.run({ loadMarkets: async () => ({ markets: [] }) })).rejects.toThrow(
    'Collector smoke check could not obtain fresh, valid price and candle inputs',
  );
  expect(session.archive.evidence.size).toBe(0);
  expect(session.archive.heartbeats.at(-1).status).toBe('error');
  for (const stream of session.streams) expect(stream.stop).toHaveBeenCalledTimes(1);
  expect(await readdir(directory)).not.toContain('collector.json.lock');
  await expect(createCollectorSession({ statePath }).run()).resolves.toMatchObject({
    status: { evidenceCount: 1 },
  });
});
