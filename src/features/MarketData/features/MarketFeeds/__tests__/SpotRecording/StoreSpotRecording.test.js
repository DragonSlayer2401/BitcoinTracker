/** @jest-environment node */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createSpotRecordingStore,
  getSpotRecordingStatus,
  pruneSpotRecordings,
  readSpotRecording,
} from '@/services/coinbase/recording/spotRecording.repository';

let directory;
let stores;
let clock;
const now = () => clock;
const row = (ordinal) => ({
  schemaVersion: 'coinbase-spot-recording-v1',
  ordinal,
  configuration: { freshnessMs: 5000 },
  input: { raw: '{"price":"70000.0100","note":"BTC € \\u20ac"}\n', receivedAt: 1_800_000_000_000 },
  normalized: { status: 'observed', price: '70000.0100' },
});
const readRows = async (filename) => {
  const rows = [];
  for await (const record of readSpotRecording(filename)) rows.push(record);
  return rows;
};
const createStore = async (options = {}) => {
  const store = await createSpotRecordingStore({ directory, now, ...options });
  stores.push(store);
  return store;
};

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'bitcoin-spot-recording-'));
  stores = [];
  clock = 1_800_000_000_000;
});

afterEach(async () => {
  jest.restoreAllMocks();
  await Promise.all(stores.map((store) => store.close().catch(() => {})));
  const selected = path.resolve(directory);
  expect(path.dirname(selected)).toBe(path.resolve(tmpdir()));
  expect(path.basename(selected)).toMatch(/^bitcoin-spot-recording-/);
  await rm(selected, { recursive: true, force: true });
});

test('records every receipt in order, preserves original text and decimals, and replays after closing', async () => {
  const store = await createStore();
  const records = [row(1), row(2)];
  const progress = await Promise.all([
    store.append(records[0]),
    store.getStatus(),
    store.append(records[1]),
    store.getStatus(),
  ]);
  expect([progress[1].recordCount, progress[3].recordCount]).toEqual([1, 2]);
  const saved = await store.getStatus();
  const expectedText = records.map((record) => `${JSON.stringify(record)}\n`).join('');
  expect(await readFile(store.location, 'utf8')).toBe(expectedText);
  expect(saved).toMatchObject({
    recordCount: 2,
    bytesRecorded: Buffer.byteLength(expectedText),
    complete: false,
    retentionHours: 0,
  });
  expect(saved.directoryBytes).toBeGreaterThan(saved.recordingBytes);
  await store.close();
  expect(await readRows(store.location)).toEqual(records);
  expect((await getSpotRecordingStatus(directory, { now })).captures[0].complete).toBe(true);
  await expect(store.append(row(3))).rejects.toMatchObject({ code: 'SPOT_RECORDING_CLOSED' });
});

test('writer ownership prevents a second writer and cleanup, and interrupted captures remain unreplayable', async () => {
  const store = await createStore();
  await store.append(row(1));
  await expect(createStore()).rejects.toMatchObject({ code: 'SPOT_RECORDING_LOCKED' });
  await expect(pruneSpotRecordings({ directory, retentionHours: 1, now })).rejects.toMatchObject({
    code: 'SPOT_RECORDING_LOCKED',
  });
  await store.close({ complete: false, error: 'synthetic interruption' });
  await expect(readRows(store.location)).rejects.toMatchObject({
    code: 'SPOT_RECORDING_INCOMPLETE',
  });
  expect(await readFile(store.location, 'utf8')).toBe(`${JSON.stringify(row(1))}\n`);
});

test('a failed ordinal cannot silently drop a receipt or produce a completed capture', async () => {
  const store = await createStore();
  await store.append(row(1));
  await expect(store.append(row(3))).rejects.toMatchObject({ code: 'SPOT_RECORDING_ORDINAL' });
  await expect(store.append(row(2))).rejects.toMatchObject({ code: 'SPOT_RECORDING_ORDINAL' });
  const final = await store.close();
  expect(final).toMatchObject({ complete: false, recordCount: 1, error: 'SPOT_RECORDING_ORDINAL' });
});

test('the byte limit counts previous captures and stops pending writes without deleting evidence', async () => {
  const bytes = Buffer.byteLength(`${JSON.stringify(row(1))}\n`);
  const first = await createStore({ maxBytes: bytes * 2 - 1 });
  await first.append(row(1));
  await first.close();
  const second = await createStore({ maxBytes: bytes * 2 - 1 });
  await expect(second.append(row(1))).rejects.toMatchObject({ code: 'SPOT_RECORDING_LIMIT' });
  expect(await second.close()).toMatchObject({ complete: false, recordCount: 0 });
  expect(await readRows(first.location)).toEqual([row(1)]);
  const status = await getSpotRecordingStatus(directory, { now });
  expect(status.recordingBytes).toBe(bytes);
  expect(status.captures).toHaveLength(2);
});

test.each(['partial line', 'invalid ordinal', 'invalid JSON'])(
  'replay rejects %s without repairing the capture',
  async (damage) => {
    const store = await createStore();
    await store.append(row(1));
    await store.close();
    const original = await readFile(store.location, 'utf8');
    const corrupted =
      damage === 'partial line'
        ? original.slice(0, -1)
        : damage === 'invalid ordinal'
          ? original.replace('"ordinal":1', '"ordinal":2')
          : `!${original.slice(1)}`;
    await writeFile(store.location, corrupted);
    await expect(readRows(store.location)).rejects.toThrow();
    expect(await readFile(store.location, 'utf8')).toBe(corrupted);
  },
);

test('retention is disabled by default and explicit cleanup removes only old completed owned captures', async () => {
  const old = await createStore({ retentionHours: 1 });
  await old.append(row(1));
  await old.close();
  const interrupted = await createStore({ retentionHours: 1 });
  await interrupted.append(row(1));
  await interrupted.close({ complete: false });
  clock += 2 * 3_600_000;
  const recent = await createStore({ retentionHours: 1 });
  await recent.append(row(1));
  await recent.close();
  await writeFile(path.join(directory, 'unowned.jsonl'), 'retain unrelated bytes');
  expect(await pruneSpotRecordings({ directory, now })).toMatchObject({
    removedCaptures: 0,
    retentionDisabled: true,
  });
  expect((await getSpotRecordingStatus(directory, { now })).retentionEligibleCaptures).toBe(1);
  expect(await pruneSpotRecordings({ directory, retentionHours: 1, now })).toMatchObject({
    removedCaptures: 1,
    retentionDisabled: false,
  });
  const files = await readdir(directory);
  expect(files).not.toContain(path.basename(old.location));
  expect(files).toContain(path.basename(interrupted.location));
  expect(files).toContain(path.basename(recent.location));
  expect(await readFile(path.join(directory, 'unowned.jsonl'), 'utf8')).toBe(
    'retain unrelated bytes',
  );
});

test('cleanup rejects a filesystem symlink report without changing the segment', async () => {
  const store = await createStore({ retentionHours: 1 });
  await store.append(row(1));
  await store.close();
  // Creating NTFS links needs privileges unavailable in the test sandbox. Only this
  // filesystem response is synthetic; archive reads, locks and cleanup run unchanged.
  const files = require('node:fs/promises');
  const readStats = files.lstat;
  jest.spyOn(files, 'lstat').mockImplementation(async (filename) => {
    const info = await readStats(filename);
    return path.resolve(filename) === path.resolve(store.location)
      ? { ...info, isFile: () => true, isSymbolicLink: () => true }
      : info;
  });
  clock += 2 * 3_600_000;
  await expect(pruneSpotRecordings({ directory, retentionHours: 1, now })).rejects.toMatchObject({
    code: 'SPOT_RECORDING_UNSAFE_PATH',
  });
  expect(await readFile(store.location, 'utf8')).toBe(`${JSON.stringify(row(1))}\n`);
});

test('cleanup retains every candidate when a completed capture has uncertain contents', async () => {
  const complete = await createStore({ retentionHours: 1 });
  await complete.append(row(1));
  await complete.close();
  const damaged = await createStore({ retentionHours: 1 });
  await damaged.append(row(1));
  await damaged.close();
  const partial = (await readFile(damaged.location, 'utf8')).slice(0, -1);
  await writeFile(damaged.location, partial);
  clock += 2 * 3_600_000;
  await expect(pruneSpotRecordings({ directory, retentionHours: 1, now })).rejects.toMatchObject({
    code: 'SPOT_RECORDING_CORRUPT',
  });
  expect(await readRows(complete.location)).toEqual([row(1)]);
  expect(await readFile(damaged.location, 'utf8')).toBe(partial);
});

test('lost ownership stops append and leaves the replacement lock intact', async () => {
  const store = await createStore();
  await store.append(row(1));
  const replacement = JSON.stringify({ token: 'synthetic-other-owner' });
  const lock = path.join(directory, '.spot-recording.lock');
  await writeFile(lock, replacement);
  await expect(store.append(row(2))).rejects.toMatchObject({ code: 'SPOT_RECORDING_LOCK_LOST' });
  await expect(store.close()).rejects.toMatchObject({ code: 'SPOT_RECORDING_LOCK_LOST' });
  expect(await readFile(lock, 'utf8')).toBe(replacement);
  expect(await readFile(store.location, 'utf8')).toBe(`${JSON.stringify(row(1))}\n`);
});

test('status does not create missing directories, and recording will not adopt unrelated files', async () => {
  const absent = path.join(directory, 'absent');
  expect(await getSpotRecordingStatus(absent, { now })).toMatchObject({
    configured: false,
    recordingBytes: 0,
  });
  expect(await readdir(directory)).not.toContain('absent');
  await writeFile(path.join(directory, 'existing.txt'), 'retain');
  await expect(createStore()).rejects.toMatchObject({ code: 'SPOT_RECORDING_DIRECTORY' });
  expect(await readFile(path.join(directory, 'existing.txt'), 'utf8')).toBe('retain');
});
