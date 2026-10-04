import 'server-only';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { ResearchDataError } from '../research.validation';

const messages = {
  stopped: 'Collection is stopped. Start it to record research and paper-trading decisions.',
  starting: 'Starting research and paper-trading collection.',
  running: 'Collection is running on this computer.',
  stopping: 'Finishing pending work before stopping. Saved research and positions are retained.',
  external:
    'A collector was started outside this app session. Stop it in its original terminal before starting one here.',
  blocked:
    'A collector ownership file remains. Existing data was retained. Verify the original collector has stopped before repairing its lock file.',
  error: 'The collector could not continue. Check collector health and the local configuration.',
  unsupported: 'In-app collection requires a local Node 24 installation with the project files.',
};

/** The child-process handle is the authority to stop; a saved PID is never sufficient. */
export function createCollectorControl({
  projectRoot = process.cwd(),
  executable = process.execPath,
  nodeVersion = process.versions.node,
  environment = process.env,
  spawnProcess = spawn,
  files = { access, mkdir, open, readFile, unlink },
  now = Date.now,
  createToken = randomUUID,
} = {}) {
  const stateLock = path.join(projectRoot, 'data', 'kalshi-collector-state.json.lock');
  const controlLock = path.join(projectRoot, 'data', 'collector-control.json.lock');
  const runner = path.join(projectRoot, 'scripts', 'run-managed-collector.mjs');
  let owned = null;
  let lastFailure = false;
  let pending = Promise.resolve();

  const serialize = (operation) => {
    const result = pending.then(operation);
    pending = result.catch(() => {});
    return result;
  };

  async function readLock(filename) {
    try {
      return JSON.parse(await files.readFile(filename, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      return { unreadable: true };
    }
  }

  async function releaseControlLock(token) {
    if ((await readLock(controlLock))?.token !== token) return;
    await files.unlink(controlLock).catch((error) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  function response(status) {
    return {
      available: status !== 'unsupported',
      status,
      canStart: ['stopped', 'error'].includes(status),
      canStop: Boolean(owned && ['starting', 'running'].includes(status)),
      managed: Boolean(owned),
      startedAt: owned?.startedAt ?? null,
      message: messages[status],
    };
  }

  async function getStatus() {
    if (
      Number(nodeVersion.split('.')[0]) < 24 ||
      environment.VERCEL ||
      environment.AWS_LAMBDA_FUNCTION_NAME ||
      environment.NETLIFY
    ) {
      return response('unsupported');
    }
    const [collectorLock, controllerLock] = await Promise.all([
      readLock(stateLock),
      readLock(controlLock),
    ]);
    if (owned) {
      if (owned.stopping) return response('stopping');
      return response(collectorLock?.pid === owned.child.pid ? 'running' : 'starting');
    }
    if (collectorLock) return response(collectorLock.unreadable ? 'blocked' : 'external');
    if (controllerLock) return response('blocked');
    return response(lastFailure ? 'error' : 'stopped');
  }

  async function start() {
    const status = await getStatus();
    if (!status.canStart) return status;
    try {
      await files.access(runner);
      await files.access(path.join(projectRoot, 'scripts', 'collect-research.mjs'));
    } catch {
      return response('unsupported');
    }
    const token = createToken();
    const startedAt = now();
    await files.mkdir(path.dirname(controlLock), { recursive: true });
    let handle;
    try {
      handle = await files.open(controlLock, 'wx', 0o600);
    } catch (error) {
      if (error.code === 'EEXIST') return getStatus();
      throw new ResearchDataError('Unable to reserve local collector ownership.', 503);
    }
    try {
      await handle.writeFile(JSON.stringify({ version: 1, token, startedAt }));
      await handle.sync();
    } catch {
      await handle.close();
      await releaseControlLock(token);
      throw new ResearchDataError('Unable to save local collector ownership.', 503);
    }
    await handle.close();
    // Another terminal may acquire the recorder lock while the launch claim is being saved.
    if (await readLock(stateLock)) {
      await releaseControlLock(token);
      return getStatus();
    }
    lastFailure = false;
    let child;
    try {
      child = spawnProcess(executable, ['--conditions=react-server', runner], {
        cwd: projectRoot,
        env: environment,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });
    } catch {
      lastFailure = true;
      await releaseControlLock(token);
      return response('error');
    }
    const session = { child, token, startedAt, stopping: false };
    owned = session;
    const finish = (failed) => {
      serialize(async () => {
        if (owned !== session) return;
        lastFailure = failed;
        owned = null;
        await releaseControlLock(token);
      }).catch(() => {
        lastFailure = true;
      });
    };
    child.once('error', () => {
      if (!Number.isInteger(child.pid)) {
        finish(true);
        return;
      }
      // An IPC failure does not prove that a running child has exited.
      lastFailure = true;
      session.stopping = true;
      if (child.connected) child.disconnect();
    });
    child.once('exit', (code) => finish(code !== 0));
    child.send({ action: 'initialize', token }, (error) => {
      if (error) {
        lastFailure = true;
        // Disconnect requests graceful shutdown in the runner; never kill by numeric PID.
        if (child.connected) child.disconnect();
      }
    });
    return response('starting');
  }

  async function stop() {
    if (!owned) return getStatus();
    if (owned.stopping) return response('stopping');
    const session = owned;
    if (!session.child.connected) {
      throw new ResearchDataError(
        'Collector control disconnected. The app will not stop an unverified process.',
        409,
      );
    }
    await new Promise((resolve, reject) => {
      session.child.send({ action: 'stop', token: session.token }, (error) => {
        if (error) {
          reject(new ResearchDataError('Unable to request a safe collector shutdown.', 503));
        } else {
          session.stopping = true;
          resolve();
        }
      });
    });
    return response('stopping');
  }

  return {
    getStatus: () => serialize(getStatus),
    start: () => serialize(start),
    stop: () => serialize(stop),
  };
}

const controllerKey = Symbol.for('bitcoin-tracker.collector-control');
function getController() {
  // Next development reloads must retain the actual child handle, not reconstruct it from a PID.
  globalThis[controllerKey] ??= createCollectorControl();
  return globalThis[controllerKey];
}

export const getCollectorControlStatus = () => getController().getStatus();
export const startManagedCollector = () => getController().start();
export const stopManagedCollector = () => getController().stop();
