import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createResearchRecorder } from '../src/features/BitcoinTracker/utils/researchRecorder.utils';

async function readJson(filename) {
  try {
    const parsed = JSON.parse(await readFile(filename, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      throw new Error('Invalid collector state.');
    return parsed;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(
      'Collector state is unreadable. Existing data was retained; repair or restore the state file before retrying.',
    );
  }
}

export async function writeCollectorState(filename, value) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${process.pid}.${randomUUID()}.tmp`;
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(JSON.stringify(value));
    await file.sync();
    await file.close();
    file = null;
    for (let attempt = 0; ; attempt++) {
      try {
        await rename(temporary, filename);
        break;
      } catch (error) {
        // Windows sync/antivirus scanners can briefly lock a closed file. Keep atomic replace;
        // never unlink the destination or fall back to a partially written state file.
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
        await delay(50 * 2 ** attempt);
      }
    }
  } finally {
    await file?.close();
    await unlink(temporary).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

/** A separate lock keeps two local processes from choosing competing targets for one recorder. */
export async function acquireCollectorLock(statePath) {
  const lockPath = `${statePath}.lock`;
  await mkdir(path.dirname(lockPath), { recursive: true });
  const identity = { pid: process.pid, host: hostname(), token: randomUUID() };
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(
      "Another collector lock exists. Stop the owning process first; after an unclean shutdown, remove only the selected state file's .lock file before restarting.",
    );
  }
  await handle.writeFile(JSON.stringify(identity));
  await handle.sync();
  await handle.close();
  return async () => {
    if ((await readJson(lockPath))?.token === identity.token) await unlink(lockPath);
  };
}

/** State and exact pending rows commit together before the durable repository sees an event. */
export async function createCollectorStateStore({ statePath, persistRows }) {
  let saved = await readJson(statePath);
  if (
    saved &&
    (!saved.state || !Array.isArray(saved.pendingRows) || saved.pendingRows.length > 100)
  ) {
    throw new Error(
      'Saved collector state is invalid. Recording is paused without resetting its target.',
    );
  }
  saved ??= { recorderId: randomUUID(), state: null, pendingRows: [] };
  // Validate immediately, including a restored deadline and issued probability snapshot.
  createResearchRecorder({ recorderId: saved.recorderId, state: saved.state });
  let running = false;

  async function advance(input) {
    if (running) throw new Error('Collector ticks cannot overlap.');
    running = true;
    try {
      if (saved.pendingRows.length) {
        await persistRows(saved.pendingRows);
        const flushed = { ...saved, pendingRows: [] };
        await writeCollectorState(statePath, flushed);
        saved = flushed;
      }
      const result = createResearchRecorder({
        recorderId: saved.recorderId,
        state: saved.state,
      }).advance(input);
      const pending = {
        recorderId: saved.recorderId,
        state: result.state,
        pendingRows: result.rows,
      };
      if (JSON.stringify(pending) !== JSON.stringify(saved)) {
        await writeCollectorState(statePath, pending);
        saved = pending;
      }
      if (saved.pendingRows.length) {
        await persistRows(saved.pendingRows);
        const flushed = { ...saved, pendingRows: [] };
        await writeCollectorState(statePath, flushed);
        saved = flushed;
      }
      return {
        status: result.status,
        rowsWritten: result.rows.length,
        recorderId: saved.recorderId,
      };
    } finally {
      running = false;
    }
  }
  return { advance, getState: () => saved.state };
}
