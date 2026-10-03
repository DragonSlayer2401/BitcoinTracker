import { Worker } from 'node:worker_threads';
import path from 'node:path';

/** CPU-heavy archive work stays off the thread receiving market data and capturing checkpoints. */
export function createCollectorBackgroundTasks({
  workerPath = path.resolve(process.cwd(), 'scripts/collect-research.worker.mjs'),
  timeoutMs = 90_000,
} = {}) {
  const jobs = new Map();
  let previous = Promise.resolve();
  let worker = null;
  let closed = false;

  function run(task) {
    if (!['analysis', 'learning'].includes(task))
      return Promise.reject(new Error('Unknown collector background task.'));
    if (closed) return Promise.reject(new Error('Collector background tasks have stopped.'));
    if (jobs.has(task)) return jobs.get(task);
    const job = previous
      .catch(() => {})
      .then(() => {
        if (closed) throw new Error('Collector background tasks have stopped.');
        return new Promise((resolve, reject) => {
          const current = new Worker(workerPath, {
            workerData: { task },
            execArgv: ['--conditions=react-server'],
            resourceLimits: { maxOldGenerationSizeMb: 768 },
          });
          worker = current;
          let result;
          let failure;
          const timer = setTimeout(() => {
            failure = new Error(
              'Collector archive task exceeded its time limit; it will retry later.',
            );
            void current.terminate();
          }, timeoutMs);
          current.on('message', (message) => {
            if (message?.ok === true) result = message.result;
            else
              failure = new Error(
                'Collector archive task failed; its previous result remains in use.',
              );
          });
          current.on('error', () => {
            failure = new Error(
              'Collector archive worker failed; its previous result remains in use.',
            );
          });
          current.on('exit', (code) => {
            clearTimeout(timer);
            if (worker === current) worker = null;
            if (failure || code !== 0 || result === undefined)
              reject(failure ?? new Error('Collector archive task stopped before completing.'));
            else resolve(result);
          });
        });
      })
      .finally(() => jobs.delete(task));
    jobs.set(task, job);
    previous = job;
    return job;
  }

  async function close() {
    closed = true;
    if (worker) await worker.terminate();
    await Promise.allSettled([...jobs.values()]);
  }
  return { run, close };
}
