/** @jest-environment node */
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  createKalshiRateLimitRepository,
  getKalshiRateLimitDatabaseConfiguration,
} from '../../../services/kalshi/rateLimit/rateLimit.repository';
import { createKalshiRatePolicy } from '../../../services/kalshi/rateLimit/rateLimit.policy';

jest.mock('server-only', () => ({}), { virtual: true });

const initialTime = Date.UTC(2026, 8, 10, 12);
const policyAt = (now = initialTime, overrides = {}) => ({
  ...createKalshiRatePolicy(
    {
      read: { refill_rate: 200, bucket_capacity: 200 },
      write: { refill_rate: 100, bucket_capacity: 100 },
    },
    { default_cost: 10, endpoint_costs: [] },
    { credentialFingerprint: 'test-key-fingerprint', now },
  ),
  ...overrides,
});

describe('shared durable Kalshi request budget', () => {
  let client;
  let repository;
  let timestamp;
  beforeEach(() => {
    timestamp = initialTime;
    client = createClient({ url: 'file::memory:' });
    repository = createKalshiRateLimitRepository({ client, now: () => timestamp });
  });
  afterEach(() => client.close());

  test('cold discovery starts empty and all discovery calls share one request per second', async () => {
    expect(await repository.getPolicy('test-key-fingerprint')).toBeNull();
    expect(await repository.reserve({ cost: 10, bootstrap: true })).toEqual({
      allowed: false,
      waitMs: 1000,
    });
    timestamp += 1000;
    expect(await repository.reserve({ cost: 10, bootstrap: true })).toEqual({
      allowed: true,
      waitMs: 0,
    });
    expect(await repository.reserve({ cost: 10, bootstrap: true })).toEqual({
      allowed: false,
      waitMs: 1000,
    });
  });

  test('a fifty-token benchmark consumes the same budget as five ten-token market reads', async () => {
    await repository.savePolicy(policyAt());
    timestamp += 1000;
    const requests = await Promise.all([
      repository.reserve({ cost: 50 }),
      ...Array.from({ length: 6 }, () => repository.reserve({ cost: 10 })),
    ]);
    expect(requests.filter((request) => request.allowed)).toHaveLength(6);
    expect(requests.at(-1)).toEqual({ allowed: false, waitMs: 100 });
    timestamp += 100;
    expect(await repository.reserve({ cost: 10 })).toEqual({ allowed: true, waitMs: 0 });
  });

  test('long idle periods cannot accumulate tokens beyond the configured burst capacity', async () => {
    await repository.savePolicy(policyAt());
    timestamp += 60_000;
    const requests = await Promise.all(
      Array.from({ length: 25 }, () => repository.reserve({ cost: 10 })),
    );
    expect(requests.filter((request) => request.allowed)).toHaveLength(10);
  });

  test('expired or mismatched policies cannot authorize ordinary requests', async () => {
    await expect(repository.reserve({ cost: 10 })).rejects.toMatchObject({ status: 503 });
    await repository.savePolicy(policyAt());
    timestamp += 1000;
    await expect(
      repository.reserve({ cost: 10, credentialFingerprint: 'rotated-key' }),
    ).rejects.toMatchObject({ status: 503 });
    expect(await repository.getPolicy('rotated-key')).toBeNull();
    timestamp = policyAt().expiresAt;
    expect(await repository.getPolicy('test-key-fingerprint')).toBeNull();
    await expect(repository.reserve({ cost: 10 })).rejects.toMatchObject({ status: 503 });
  });

  test('reconstructing the repository or changing credentials creates no new budget', async () => {
    await repository.savePolicy(policyAt());
    timestamp += 1000;
    expect((await repository.reserve({ cost: 100 })).allowed).toBe(true);
    const restarted = createKalshiRateLimitRepository({ client, now: () => timestamp });
    expect((await restarted.reserve({ cost: 10 })).allowed).toBe(false);
    await restarted.savePolicy(policyAt(timestamp, { credentialFingerprint: 'rotated-key' }));
    expect((await restarted.reserve({ cost: 10 })).allowed).toBe(false);
    expect(await restarted.getPolicy('test-key-fingerprint')).toBeNull();
    expect(await restarted.getPolicy('rotated-key')).toMatchObject({
      credentialFingerprint: 'rotated-key',
    });
  });

  test('a stale asynchronous policy response cannot replace a newer policy', async () => {
    await repository.savePolicy(policyAt());
    timestamp += 1000;
    await repository.savePolicy(policyAt(timestamp, { refillRate: 20, bucketCapacity: 50 }));
    await repository.savePolicy(policyAt());
    expect(await repository.getPolicy('test-key-fingerprint')).toMatchObject({ refillRate: 20 });
  });

  test('lower limits clamp existing balances without issuing a fresh burst', async () => {
    await repository.savePolicy(policyAt());
    timestamp += 1000;
    await repository.reserve({ cost: 10 });
    await repository.savePolicy(policyAt(timestamp, { refillRate: 20, bucketCapacity: 40 }));
    const requests = await Promise.all(
      Array.from({ length: 5 }, () => repository.reserve({ cost: 10 })),
    );
    expect(requests.filter((request) => request.allowed)).toHaveLength(4);
    expect(requests.at(-1)).toEqual({ allowed: false, waitMs: 500 });
  });

  test('normal reservation rechecks the persisted endpoint cost atomically', async () => {
    await repository.savePolicy(
      policyAt(initialTime, {
        endpointCosts: [{ method: 'GET', path: '/series/KXBTC15M', cost: 70 }],
      }),
    );
    timestamp += 1000;
    expect(await repository.reserve({ cost: 10, path: '/series/KXBTC15M' })).toEqual({
      allowed: true,
      waitMs: 0,
    });
    expect(await repository.reserve({ cost: 10, path: '/series/KXBTC15M' })).toEqual({
      allowed: false,
      waitMs: 400,
    });
  });

  test('known discovery policy uses the lower configured rate and cannot bypass endpoint costs', async () => {
    await repository.savePolicy(policyAt(initialTime, { refillRate: 20, bucketCapacity: 50 }));
    expect(await repository.reserve({ cost: 10, bootstrap: true })).toEqual({
      allowed: false,
      waitMs: 2500,
    });
    timestamp += 2500;
    expect((await repository.reserve({ cost: 10, bootstrap: true })).allowed).toBe(true);
    expect(await repository.reserve({ cost: 10, bootstrap: true })).toEqual({
      allowed: false,
      waitMs: 2500,
    });
  });

  test('bootstrap cannot bypass verified account limits for ordinary market or benchmark reads', async () => {
    for (const requestPath of ['/series/KXBTC15M', '/cfbenchmarks/values?id=BRTI']) {
      await expect(
        repository.reserve({ cost: 50, bootstrap: true, path: requestPath }),
      ).rejects.toMatchObject({ status: 400 });
    }
    expect(
      await repository.reserve({ cost: 50, bootstrap: true, path: '/account/limits' }),
    ).toEqual({
      allowed: false,
      waitMs: 1000,
    });
  });

  test.each([0, -1, NaN, Infinity, 101])(
    'rejects invalid or unaffordable request cost %s',
    async (cost) => {
      await repository.savePolicy(policyAt());
      timestamp += 1000;
      await expect(repository.reserve({ cost })).rejects.toMatchObject({ status: 503 });
    },
  );

  test('backward clock movement never adds tokens or rewinds the refill boundary', async () => {
    await repository.savePolicy(policyAt());
    timestamp += 1000;
    await repository.reserve({ cost: 100 });
    timestamp -= 500;
    expect((await repository.reserve({ cost: 10 })).allowed).toBe(false);
    timestamp += 500;
    expect((await repository.reserve({ cost: 10 })).allowed).toBe(false);
    timestamp += 100;
    expect((await repository.reserve({ cost: 10 })).allowed).toBe(true);
  });

  test('429 cooldown persists, escalates, and survives unrelated success and policy refresh', async () => {
    await repository.savePolicy(policyAt());
    expect(await repository.block()).toEqual({ waitMs: 2000 });
    timestamp += 1000;
    await repository.noteSuccess();
    await repository.savePolicy(policyAt(timestamp));
    expect((await repository.reserve({ cost: 10 })).waitMs).toBe(1000);
    const restarted = createKalshiRateLimitRepository({ client, now: () => timestamp });
    expect(await restarted.block()).toEqual({ waitMs: 4000 });
    expect((await repository.reserve({ cost: 10 })).waitMs).toBe(4000);
    for (let index = 0; index < 10; index += 1) await repository.block();
    expect(await repository.block()).toEqual({ waitMs: 60_000 });
    expect(await repository.block({ retryAfterMs: 120_000 })).toEqual({ waitMs: 120_000 });
    expect(await repository.block()).toEqual({ waitMs: 120_000 });
  });

  test('corrupt persisted state fails closed and is not reset', async () => {
    await repository.savePolicy(policyAt());
    await client.execute('UPDATE kalshi_rate_limit_state SET tokens = 1000');
    const restarted = createKalshiRateLimitRepository({ client, now: () => timestamp });
    await expect(restarted.reserve({ cost: 10, bootstrap: true })).rejects.toMatchObject({
      status: 503,
    });
    expect(
      (await client.execute('SELECT tokens FROM kalshi_rate_limit_state')).rows[0].tokens,
    ).toBe(1000);
    await client.execute('DELETE FROM kalshi_rate_limit_state');
    await expect(restarted.getPolicy('test-key-fingerprint')).rejects.toMatchObject({
      status: 503,
    });
    expect((await client.execute('SELECT * FROM kalshi_rate_limit_state')).rows).toHaveLength(0);
  });

  test('malformed or unsafe persisted policies cannot increase the known account limit', async () => {
    for (const overrides of [
      { refillRate: 101 },
      { bucketCapacity: 101 },
      { endpointCosts: {} },
      { defaultCost: -1 },
      { reportedRead: { refill_rate: 20, bucket_capacity: 20 } },
      { expiresAt: initialTime + 600_000 },
    ]) {
      await expect(repository.savePolicy(policyAt(initialTime, overrides))).rejects.toMatchObject({
        status: 503,
      });
    }
    expect(await repository.getPolicy('test-key-fingerprint')).toBeNull();
  });

  test('storage failures never issue an in-memory allowance or expose raw errors', async () => {
    const failed = createKalshiRateLimitRepository({
      client: {
        transaction: async () => {
          throw new Error('secret-token private-database-path');
        },
      },
      now: () => timestamp,
    });
    for (const operation of [
      () => failed.getPolicy('test-key-fingerprint'),
      () => failed.reserve({ cost: 50, bootstrap: true }),
      () => failed.block(),
    ]) {
      await expect(operation()).rejects.toMatchObject({ status: 503 });
      await expect(operation()).rejects.not.toThrow('secret-token');
    }
  });

  test.each(['SQLITE_BUSY', 'SQLITE_LOCKED'])(
    'retries transient %s contention without replacing the saved policy or balance',
    async (code) => {
      await repository.savePolicy(policyAt());
      timestamp += 1000;
      await repository.reserve({ cost: 90 });
      const originalTransaction = client.transaction.bind(client);
      const transaction = jest
        .spyOn(client, 'transaction')
        .mockRejectedValueOnce(Object.assign(new Error('private-database-path'), { code }))
        .mockRejectedValueOnce(Object.assign(new Error('private-database-path'), { code }))
        .mockImplementation(originalTransaction);
      try {
        expect(await repository.reserve({ cost: 10 })).toEqual({ allowed: true, waitMs: 0 });
        expect(transaction).toHaveBeenCalledTimes(3);
        expect((await repository.reserve({ cost: 10 })).allowed).toBe(false);
        expect(await repository.getPolicy('test-key-fingerprint')).toEqual(policyAt());
      } finally {
        transaction.mockRestore();
      }
    },
  );

  test.each(['SQLITE_BUSY', 'SQLITE_LOCKED'])(
    'persistent %s contention stops after four attempts and keeps the shared cooldown',
    async (code) => {
      await repository.savePolicy(policyAt());
      await repository.block({ retryAfterMs: 10_000 });
      const transaction = jest
        .spyOn(client, 'transaction')
        .mockRejectedValue(
          Object.assign(new Error('secret-token private-database-path'), { code }),
        );
      try {
        await expect(repository.reserve({ cost: 10 })).rejects.toMatchObject({
          status: 503,
          message: expect.not.stringContaining('secret-token'),
        });
        expect(transaction).toHaveBeenCalledTimes(4);
      } finally {
        transaction.mockRestore();
      }
      expect((await repository.reserve({ cost: 10 })).waitMs).toBe(10_000);
    },
  );

  test('does not retry unrelated storage failures', async () => {
    const transaction = jest
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('private-database-path'), { code: 'SQLITE_IOERR' }),
      );
    const failed = createKalshiRateLimitRepository({ client: { transaction } });
    await expect(failed.getPolicy('test-key-fingerprint')).rejects.toMatchObject({ status: 503 });
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  test('default production timing comes from the shared database clock', async () => {
    const databaseTimed = createKalshiRateLimitRepository({ client });
    const before = Date.now();
    await databaseTimed.getPolicy('test-key-fingerprint');
    const timestampRow = (await client.execute('SELECT updated_at FROM kalshi_rate_limit_state'))
      .rows[0];
    expect(Number(timestampRow.updated_at)).toBeGreaterThanOrEqual(before - 1000);
    expect(Number(timestampRow.updated_at)).toBeLessThanOrEqual(Date.now() + 1000);
  });
});

describe('shared Kalshi limiter configuration', () => {
  test('uses a separate local file instead of the research database', () => {
    expect(getKalshiRateLimitDatabaseConfiguration({}).url).toMatch(
      /data\/kalshi-rate-limits\.db$/,
    );
    expect(
      getKalshiRateLimitDatabaseConfiguration({ TURSO_DATABASE_URL: 'file:/research.db' }).url,
    ).toMatch(/kalshi-rate-limits\.db$/);
  });
  test.each(['VERCEL', 'AWS_LAMBDA_FUNCTION_NAME', 'NETLIFY'])(
    'requires remote shared storage on %s',
    (host) => {
      expect(() => getKalshiRateLimitDatabaseConfiguration({ [host]: 'host' })).toThrow(
        'shared remote',
      );
      expect(() =>
        getKalshiRateLimitDatabaseConfiguration({
          [host]: 'host',
          KALSHI_RATE_LIMIT_DATABASE_URL: 'file:/tmp/local.db',
        }),
      ).toThrow('shared remote');
    },
  );
  test('reuses a remote research store by default and supports an independent override', () => {
    expect(
      getKalshiRateLimitDatabaseConfiguration({
        TURSO_DATABASE_URL: 'libsql://research.example',
        TURSO_AUTH_TOKEN: 'research-token',
      }),
    ).toEqual({ url: 'libsql://research.example', authToken: 'research-token' });
    expect(
      getKalshiRateLimitDatabaseConfiguration({
        VERCEL: '1',
        TURSO_DATABASE_URL: 'libsql://research.example',
        TURSO_AUTH_TOKEN: 'research-token',
        KALSHI_RATE_LIMIT_DATABASE_URL: 'https://limits.example',
        KALSHI_RATE_LIMIT_AUTH_TOKEN: 'limit-token',
      }),
    ).toEqual({ url: 'https://limits.example', authToken: 'limit-token' });
  });
  test.each(['http://limits.example', 'file::memory:', 'file:/tmp/x?mode=memory'])(
    'refuses non-durable or unsupported database %s',
    (url) => {
      expect(() =>
        getKalshiRateLimitDatabaseConfiguration({ KALSHI_RATE_LIMIT_DATABASE_URL: url }),
      ).toThrow('durable');
    },
  );
  test('requires remote authentication', () => {
    expect(() =>
      getKalshiRateLimitDatabaseConfiguration({
        KALSHI_RATE_LIMIT_DATABASE_URL: 'libsql://limits.example',
      }),
    ).toThrow('AUTH_TOKEN');
  });
});

test('separate real-file clients share bursts and recover safely after a held write lock', async () => {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'kalshi-limits-test-'));
  try {
    const output = execFileSync(
      process.execPath,
      [
        '--conditions=react-server',
        '-e',
        `
      const assert = require('node:assert/strict');
      const { createClient } = require('@libsql/client');
      (async () => {
        await import('tsx');
        const module = await import('./src/services/kalshi/rateLimit/rateLimit.repository.js');
        const { createKalshiRateLimitRepository } = module.default ?? module;
        const first = createClient({ url: process.env.KALSHI_LIMIT_TEST_URL });
        const second = createClient({ url: process.env.KALSHI_LIMIT_TEST_URL });
        let timestamp = ${initialTime};
        const a = createKalshiRateLimitRepository({ client: first, now: () => timestamp });
        const b = createKalshiRateLimitRepository({ client: second, now: () => timestamp });
        let lock;
        try {
          await a.savePolicy(JSON.parse(process.env.KALSHI_LIMIT_TEST_POLICY));
          timestamp += 1000;
          const burst = await Promise.allSettled(Array.from({ length: 24 }, (_, index) => (index % 2 ? a : b).reserve({cost:10})));
          const allowed = burst.filter(value => value.status === 'fulfilled' && value.value.allowed).length;
          assert.ok(allowed > 0 && allowed <= 10);
          for (const value of burst) if (value.status === 'rejected') assert.equal(value.reason.status, 503);
          let drain = 0;
          while ((await a.reserve({cost:10})).allowed) drain++;
          assert.equal(allowed + drain, 10);
          const restarted = createKalshiRateLimitRepository({ client: second, now: () => timestamp });
          assert.equal((await restarted.reserve({cost:10})).allowed, false);
          await a.block();
          assert.equal((await b.reserve({cost:10})).waitMs, 2000);
          timestamp += 2000;
          for (let cycle = 0; cycle < 3; cycle++) {
            lock = await second.transaction('write');
            await assert.rejects(a.reserve({cost:10}), {status:503});
            await assert.rejects(a.block(), {status:503});
            await lock.rollback();
            lock.close();
            lock = null;
            assert.equal((await a.reserve({cost:10})).allowed, true);
            timestamp += 1000;
          }
          lock = await second.transaction('write');
          const released = (async () => {
            await new Promise(resolve => setTimeout(resolve, 30));
            await lock.rollback();
            lock.close();
            lock = null;
          })();
          const [recovered] = await Promise.all([a.reserve({cost:10}), released]);
          assert.equal(recovered.allowed, true);
          process.stdout.write('verified');
        } finally {
          lock?.close();
          first.close();
          second.close();
        }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `,
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.resolve('jsconfig.json'),
          KALSHI_LIMIT_TEST_URL: pathToFileURL(path.join(folder, 'limits.db')).href,
          KALSHI_LIMIT_TEST_POLICY: JSON.stringify(policyAt()),
        },
      },
    );
    expect(output).toBe('verified');
  } finally {
    const resolvedFolder = path.resolve(folder);
    if (
      !resolvedFolder.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`) ||
      !path.basename(resolvedFolder).startsWith('kalshi-limits-test-')
    ) {
      throw new Error('Refusing cleanup outside the verified Kalshi limit test directory.');
    }
    await rm(resolvedFolder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
