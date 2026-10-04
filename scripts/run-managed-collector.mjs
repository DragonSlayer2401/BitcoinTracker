import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnvFile } from 'node:process';
import { readFile, unlink } from 'node:fs/promises';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const lockPath = path.join(projectRoot, 'data', 'collector-control.json.lock');
let ownerToken = null;
let stopRequested = false;
const stop = () => {
  stopRequested = true;
  // The existing command owns draining work, closing feeds and releasing its recorder lock.
  // Emitting its handler keeps this graceful on Windows, where OS SIGTERM is a forced stop.
  if (process.listenerCount('SIGTERM')) process.emit('SIGTERM');
};
const receive = (message) => {
  if (message?.action === 'stop' && message.token === ownerToken) stop();
};
process.on('message', receive);
process.on('disconnect', stop);

try {
  ownerToken = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Initialization timed out.')), 5000);
    process.once('message', (message) => {
      clearTimeout(timeout);
      if (message?.action !== 'initialize' || !/^[a-f\d-]{36}$/i.test(message.token ?? '')) {
        reject(new Error('Invalid controller initialization.'));
      } else resolve(message.token);
    });
  });
  const ownership = JSON.parse(await readFile(lockPath, 'utf8'));
  if (ownership.token !== ownerToken) throw new Error('Collector ownership changed.');
  process.chdir(projectRoot);
  process.env.TSX_TSCONFIG_PATH = path.join(projectRoot, 'jsconfig.json');
  for (const filename of ['.env.local', '.env']) {
    try {
      loadEnvFile(path.join(projectRoot, filename));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  await import('tsx');
  const { runCollectorCommand } = await import('./collect-research.runtime.js');
  if (!stopRequested) {
    await runCollectorCommand(['--paper-trading', '--trading-advisor']);
  }
} catch {
  // The UI reports a fixed message; raw configuration errors may contain secrets or paths.
  process.exitCode = 1;
} finally {
  try {
    const ownership = JSON.parse(await readFile(lockPath, 'utf8'));
    if (ownerToken && ownership.token === ownerToken) await unlink(lockPath);
  } catch {
    // An unreadable lock stays in place. Never remove an unverified owner's reservation.
  }
  process.removeListener('message', receive);
  process.removeListener('disconnect', stop);
  if (process.connected) process.disconnect();
}
