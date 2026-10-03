/** @jest-environment node */
import path from 'node:path';
import { createCollectorBackgroundTasks } from '../../../../scripts/collect-research.background';

const workerPath = path.resolve(__dirname, 'fixtures/CollectorWorker.fixture.mjs');

test('archive work leaves the receiving thread responsive and deduplicates the same task', async () => {
  const background = createCollectorBackgroundTasks({ workerPath, timeoutMs: 5000 });
  try {
    let completed = false;
    const job = background.run('analysis');
    job.then(() => {
      completed = true;
    });
    expect(background.run('analysis')).toBe(job);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(completed).toBe(false);
    await expect(job).resolves.toEqual({ completed: true });
  } finally {
    await background.close();
  }
});

test('a timed-out worker is terminated before a later archive job starts', async () => {
  const background = createCollectorBackgroundTasks({ workerPath, timeoutMs: 300 });
  try {
    const hung = background.run('learning');
    const subsequent = background.run('analysis');
    await expect(hung).rejects.toThrow('time limit');
    await expect(subsequent).resolves.toEqual({ completed: true });
  } finally {
    await background.close();
  }
});

test('shutdown terminates active work and rejects queued jobs without leaking another worker', async () => {
  const background = createCollectorBackgroundTasks({ workerPath, timeoutMs: 5000 });
  const current = background.run('learning');
  const queued = background.run('analysis');
  const results = Promise.allSettled([current, queued]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await background.close();
  expect((await results).every((result) => result.status === 'rejected')).toBe(true);
  await expect(background.run('analysis')).rejects.toThrow('stopped');
});
