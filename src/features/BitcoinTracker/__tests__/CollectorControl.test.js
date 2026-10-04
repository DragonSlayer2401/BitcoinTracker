/** @jest-environment node */
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { createCollectorControl } from '../../../services/research/collectorControl/collectorControl.service';

jest.mock('server-only', () => ({}), { virtual: true });

function setup(overrides = {}) {
  const projectRoot = path.resolve('collector-test-project');
  const stateLock = path.join(projectRoot, 'data', 'kalshi-collector-state.json.lock');
  const controlLock = path.join(projectRoot, 'data', 'collector-control.json.lock');
  const data = new Map();
  const missing = () => Object.assign(new Error('Missing'), { code: 'ENOENT' });
  const files = {
    access: jest.fn(async () => {}),
    mkdir: jest.fn(async () => {}),
    readFile: jest.fn(async (filename) => {
      if (!data.has(filename)) throw missing();
      return data.get(filename);
    }),
    unlink: jest.fn(async (filename) => {
      if (!data.delete(filename)) throw missing();
    }),
    open: jest.fn(async (filename, flags) => {
      if (flags !== 'wx') throw new Error('Exclusive ownership is required.');
      if (data.has(filename)) throw Object.assign(new Error('Exists'), { code: 'EEXIST' });
      data.set(filename, '');
      return {
        writeFile: async (value) => data.set(filename, value),
        sync: async () => {},
        close: async () => {},
      };
    }),
  };
  const child = new EventEmitter();
  child.pid = 123;
  child.connected = true;
  child.send = jest.fn((message, callback) => callback?.(null));
  child.kill = jest.fn();
  child.disconnect = jest.fn(() => {
    child.connected = false;
  });
  const spawnProcess = jest.fn(() => child);
  const dependencies = {
    projectRoot,
    executable: '/trusted/node',
    nodeVersion: '24.0.0',
    environment: {},
    files,
    spawnProcess,
    now: () => 1000,
    createToken: () => 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    ...overrides,
  };
  return {
    controller: createCollectorControl(dependencies),
    dependencies,
    child,
    spawnProcess,
    files,
    data,
    stateLock,
    controlLock,
    projectRoot,
  };
}

describe('local managed collector controls', () => {
  test('status has no market calls and cannot launch a child process', async () => {
    const { controller, spawnProcess, files } = setup();
    expect(await controller.getStatus()).toMatchObject({
      status: 'stopped',
      canStart: true,
      canStop: false,
      managed: false,
    });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(files.open).not.toHaveBeenCalled();
  });

  test('uses one fixed hidden Node command and marks running only after it owns the recorder lock', async () => {
    const { controller, spawnProcess, child, data, stateLock, controlLock, projectRoot } = setup();
    expect(await controller.start()).toMatchObject({ status: 'starting', canStop: true });
    expect(spawnProcess).toHaveBeenCalledWith(
      '/trusted/node',
      ['--conditions=react-server', path.join(projectRoot, 'scripts', 'run-managed-collector.mjs')],
      expect.objectContaining({
        cwd: projectRoot,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
    );
    expect(data.has(controlLock)).toBe(true);
    expect(child.send).toHaveBeenCalledWith(
      { action: 'initialize', token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      expect.any(Function),
    );
    expect(await controller.getStatus()).toMatchObject({ status: 'starting' });
    data.set(stateLock, JSON.stringify({ pid: child.pid, token: 'recorder-token' }));
    const status = await controller.getStatus();
    expect(status).toMatchObject({ status: 'running', managed: true, startedAt: 1000 });
    expect(JSON.stringify(status)).not.toMatch(/123|token|node|collector-test-project/);
  });

  test('serializes duplicate starts, including competing app workers', async () => {
    const { controller, dependencies, spawnProcess } = setup();
    const otherWorker = createCollectorControl({ ...dependencies, createToken: () => 'other' });
    await Promise.all([controller.start(), controller.start(), otherWorker.start()]);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  test('stops through the owned IPC handle and waits for graceful exit to release ownership', async () => {
    const { controller, child, data, controlLock } = setup();
    await controller.start();
    expect(await controller.stop()).toMatchObject({ status: 'stopping', canStop: false });
    expect(data.has(controlLock)).toBe(true);
    expect(child.send).toHaveBeenLastCalledWith(
      { action: 'stop', token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' },
      expect.any(Function),
    );
    expect(child.kill).not.toHaveBeenCalled();
    expect(await controller.stop()).toMatchObject({ status: 'stopping' });
    expect(child.send).toHaveBeenCalledTimes(2);
    child.emit('exit', 0);
    expect(await controller.getStatus()).toMatchObject({ status: 'stopped', managed: false });
    expect(data.has(controlLock)).toBe(false);
  });

  test('never stops an external collector or reconstructs ownership from a reused saved PID', async () => {
    const { controller, child, data, stateLock, spawnProcess } = setup();
    data.set(stateLock, JSON.stringify({ pid: child.pid, token: 'external' }));
    for (const action of [controller.getStatus, controller.start, controller.stop]) {
      expect(await action()).toMatchObject({
        status: 'external',
        canStart: false,
        canStop: false,
        managed: false,
      });
    }
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.send).not.toHaveBeenCalled();
  });

  test('app restart preserves ownership files instead of pretending it owns the old child', async () => {
    const { controller, dependencies, child } = setup();
    await controller.start();
    child.send.mockClear();
    const restarted = createCollectorControl(dependencies);
    expect(await restarted.stop()).toMatchObject({ status: 'blocked', canStop: false });
    expect(child.send).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
  });

  test.each(['stateLock', 'controlLock'])(
    'retains corrupt %s without starting or unlinking anything',
    async (key) => {
      const context = setup();
      context.data.set(context[key], 'not-json');
      expect(await context.controller.start()).toMatchObject({
        status: 'blocked',
        canStart: false,
      });
      expect(context.spawnProcess).not.toHaveBeenCalled();
      expect(context.files.unlink).not.toHaveBeenCalled();
    },
  );

  test('cleans up its launch claim on spawn failure without leaking errors or deleting the recorder lock', async () => {
    const spawnProcess = jest.fn(() => {
      throw new Error('secret-config-value');
    });
    const { controller, data, controlLock, files } = setup({ spawnProcess });
    const status = await controller.start();
    expect(status.status).toBe('error');
    expect(JSON.stringify(status)).not.toContain('secret-config-value');
    expect(data.has(controlLock)).toBe(false);
    expect(files.unlink).toHaveBeenCalledTimes(1);
  });

  test('backs out if a terminal collector claims the recorder while the launch reservation is saved', async () => {
    const { controller, files, data, stateLock, controlLock, spawnProcess } = setup();
    const originalOpen = files.open.getMockImplementation();
    files.open.mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      const sync = handle.sync;
      handle.sync = async () => {
        await sync();
        data.set(stateLock, JSON.stringify({ pid: 999, token: 'terminal-owner' }));
      };
      return handle;
    });
    expect(await controller.start()).toMatchObject({ status: 'external', canStart: false });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(data.has(controlLock)).toBe(false);
    expect(data.has(stateLock)).toBe(true);
  });

  test('keeps a running child reserved after an IPC error until it actually exits', async () => {
    const { controller, child, data, controlLock, spawnProcess } = setup();
    await controller.start();
    child.emit('error', new Error('channel failure'));
    expect(await controller.getStatus()).toMatchObject({ status: 'stopping', canStart: false });
    expect(data.has(controlLock)).toBe(true);
    expect(child.disconnect).toHaveBeenCalledTimes(1);
    await controller.start();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    child.emit('exit', 1);
    expect(await controller.getStatus()).toMatchObject({ status: 'error', canStart: true });
    expect(data.has(controlLock)).toBe(false);
  });

  test('clears the launch claim when asynchronous spawning fails before a process exists', async () => {
    const { controller, child, data, controlLock } = setup();
    await controller.start();
    child.pid = undefined;
    child.emit('error', new Error('spawn unavailable'));
    expect(await controller.getStatus()).toMatchObject({ status: 'error', canStart: true });
    expect(data.has(controlLock)).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
  });

  test('an abnormal child exit retains a recorder lock and never removes a new controller owner', async () => {
    const { controller, child, data, controlLock, stateLock } = setup();
    await controller.start();
    data.set(controlLock, JSON.stringify({ token: 'replacement-owner' }));
    data.set(stateLock, JSON.stringify({ pid: child.pid, token: 'old-recorder' }));
    child.emit('exit', 1);
    expect(await controller.getStatus()).toMatchObject({ status: 'external', canStart: false });
    expect(data.has(stateLock)).toBe(true);
    expect(JSON.parse(data.get(controlLock)).token).toBe('replacement-owner');
  });

  test('refuses a disconnected handle instead of using force termination', async () => {
    const { controller, child } = setup();
    await controller.start();
    child.connected = false;
    await expect(controller.stop()).rejects.toMatchObject({ status: 409 });
    expect(child.kill).not.toHaveBeenCalled();
  });

  test.each([
    { nodeVersion: '22.0.0' },
    { environment: { VERCEL: '1' } },
    { environment: { AWS_LAMBDA_FUNCTION_NAME: 'worker' } },
    { environment: { NETLIFY: '1' } },
  ])('disables process controls on unsupported hosts %j', async (options) => {
    const { controller, spawnProcess, files } = setup(options);
    expect(await controller.start()).toMatchObject({ status: 'unsupported', available: false });
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(files.open).not.toHaveBeenCalled();
  });
});
