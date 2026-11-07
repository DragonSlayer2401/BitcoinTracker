/** @jest-environment node */
import { runSpotCaptureCommand } from '../../../../../../../scripts/capture-spot.runtime';

test('status and replay expose their result without creating a network recorder', async () => {
  const createRecorder = jest.fn();
  const write = jest.fn();
  const readStatus = jest.fn().mockResolvedValue({ state: 'idle', rawBytes: 123, recordings: 1 });
  const replay = jest.fn().mockResolvedValue({ verified: true, records: 12 });
  await runSpotCaptureCommand(
    ['status', '--directory', 'test-artifacts/synthetic-spot', '--json'],
    {
      createRecorder,
      readStatus,
      write,
    },
  );
  expect(JSON.parse(write.mock.calls[0][0])).toMatchObject({ rawBytes: 123 });
  await runSpotCaptureCommand(
    ['replay', '--file', 'test-artifacts/synthetic-spot.jsonl', '--json'],
    {
      createRecorder,
      replay,
      write,
    },
  );
  expect(JSON.parse(write.mock.calls[1][0])).toEqual({ verified: true, records: 12 });
  expect(createRecorder).not.toHaveBeenCalled();
});

test('invalid command options never start capture or silently authorize retention', async () => {
  const createRecorder = jest.fn();
  const prune = jest.fn();
  for (const args of [
    ['prune'],
    ['prune', '--retention-hours', '0'],
    ['record', '--max-bytes', '-1'],
    ['record', '--duration-seconds', '0'],
    ['record', '--max-pending-records', '1.5'],
    ['status', '--duration-seconds', '5'],
    ['replay'],
  ])
    await expect(runSpotCaptureCommand(args, { createRecorder, prune })).rejects.toThrow();
  expect(createRecorder).not.toHaveBeenCalled();
  expect(prune).not.toHaveBeenCalled();
});

test('an explicitly requested retention action passes only the selected archive policy', async () => {
  const prune = jest.fn().mockResolvedValue({ removedCaptures: [], removedBytes: 0 });
  const report = await runSpotCaptureCommand(
    ['prune', '--directory', 'test-artifacts/synthetic-spot', '--retention-hours', '24', '--json'],
    { prune, write: jest.fn() },
  );
  expect(prune).toHaveBeenCalledWith({
    directory: expect.stringContaining('synthetic-spot'),
    retentionHours: 24,
  });
  expect(report.removedBytes).toBe(0);
});

test('a failed recording stops and reports failure instead of a successful final result', async () => {
  const recorder = {
    start: jest.fn(),
    getStatus: jest
      .fn()
      .mockResolvedValue({ state: 'failed', error: 'Synthetic storage limit reached.' }),
    stop: jest.fn().mockRejectedValue(new Error('Synthetic storage limit reached.')),
  };
  const write = jest.fn();
  await expect(
    runSpotCaptureCommand(['record', '--duration-seconds', '1'], {
      createRecorder: jest.fn().mockResolvedValue(recorder),
      write,
    }),
  ).rejects.toThrow('Synthetic storage limit reached.');
  expect(recorder.start).toHaveBeenCalledTimes(1);
  expect(recorder.stop).toHaveBeenCalledTimes(1);
  expect(write).not.toHaveBeenCalled();
});
