import { parentPort, workerData } from 'node:worker_threads';

if (workerData.task === 'learning') {
  // Deliberately busy worker verifies termination without blocking the Jest/main thread.
  while (true) {}
}
const end = Date.now() + 60;
while (Date.now() < end) {}
parentPort.postMessage({ ok: true, result: { completed: true } });
parentPort.close();
