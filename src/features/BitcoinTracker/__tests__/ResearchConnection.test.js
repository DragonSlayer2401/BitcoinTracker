/** @jest-environment node */
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getResearchReadTransaction,
  getResearchWriteTransaction,
  runResearchConnectionOperation,
} from '@/services/research/research.connection';

jest.mock('server-only', () => ({}), { virtual: true });

test('independent operations on one client commit without losing increments or borrowing an open transaction', async () => {
  const client = createClient({ url: 'file::memory:' });
  try {
    await client.execute('CREATE TABLE counter(value INTEGER)');
    await client.execute('INSERT INTO counter VALUES (0)');
    await Promise.all(
      Array.from({ length: 20 }, async () => {
        const transaction = await getResearchWriteTransaction(client);
        try {
          await transaction.execute('UPDATE counter SET value = value + 1');
          await transaction.commit();
        } finally {
          transaction.close();
        }
      }),
    );
    expect((await client.execute('SELECT value FROM counter')).rows[0].value).toBe(20);
  } finally {
    client.close();
  }
});

test.each(['commit', 'rollback', 'close'])(
  '%s releases the local reservation for the next reader and writer',
  async (finish) => {
    const client = createClient({ url: 'file::memory:' });
    try {
      await client.execute('CREATE TABLE counter(value INTEGER)');
      await client.execute('INSERT INTO counter VALUES (0)');
      const first = await getResearchWriteTransaction(client);
      await first.execute('UPDATE counter SET value = 1');
      const waiting = getResearchReadTransaction(client);
      await first[finish]();
      const reader = await waiting;
      expect((await reader.execute('SELECT value FROM counter')).rows[0].value).toBe(
        finish === 'commit' ? 1 : 0,
      );
      await reader.commit();
      first.close();
      reader.close();
      await runResearchConnectionOperation(client, () =>
        client.execute('UPDATE counter SET value = 2'),
      );
      expect((await client.execute('SELECT value FROM counter')).rows[0].value).toBe(2);
    } finally {
      client.close();
    }
  },
);

test('failed acquisition releases the queue and non-lock errors are not retried', async () => {
  const client = createClient({ url: 'file::memory:' });
  const begin = client.transaction.bind(client);
  const spy = jest
    .spyOn(client, 'transaction')
    .mockRejectedValueOnce(Object.assign(new Error('disk failure'), { code: 'SQLITE_IOERR' }))
    .mockImplementation(begin);
  try {
    await expect(getResearchWriteTransaction(client)).rejects.toMatchObject({
      code: 'SQLITE_IOERR',
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const transaction = await getResearchWriteTransaction(client);
    await transaction.rollback();
  } finally {
    client.close();
  }
});

test.each(['commit', 'rollback'])(
  'a failed %s cannot release an open transaction to the next caller before cleanup',
  async (finish) => {
    const client = createClient({ url: 'file::memory:' });
    const begin = client.transaction.bind(client);
    jest.spyOn(client, 'transaction').mockImplementationOnce(async (mode) => {
      const transaction = await begin(mode);
      jest.spyOn(transaction, finish).mockRejectedValueOnce(new Error('transaction still open'));
      return transaction;
    });
    let first;
    try {
      first = await getResearchWriteTransaction(client);
      await expect(first[finish]()).rejects.toThrow('transaction still open');
      const next = getResearchWriteTransaction(client);
      // Let a wrongly released reservation try borrowing the single native connection.
      const result = next.then(
        (transaction) => ({ transaction }),
        (error) => ({ error }),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      first.close();
      const resumed = await result;
      expect(resumed.error).toBeUndefined();
      await resumed.transaction.rollback();
    } finally {
      first?.close();
      client.close();
    }
  },
);

test('remote transactions keep their existing driver semantics', async () => {
  const transaction = {};
  const client = { protocol: 'https', transaction: jest.fn(async () => transaction) };
  expect(await getResearchWriteTransaction(client)).toBe(transaction);
  expect(await getResearchReadTransaction(client)).toBe(transaction);
  expect(client.transaction.mock.calls).toEqual([['write'], ['read']]);
  expect(await runResearchConnectionOperation(client, async () => 'result')).toBe('result');
});

test('real file clients tolerate short contention, preserve rollback, and still report a persistent external lock', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bitcoin-connection-tests-'));
  try {
    const output = execFileSync(
      process.execPath,
      [
        '--conditions=react-server',
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
          import assert from 'node:assert/strict';
          import {createClient} from '@libsql/client';
          import {setTimeout as delay} from 'node:timers/promises';
          const connection = await import('./src/services/research/research.connection.js');
          const {getResearchWriteTransaction, getResearchReadTransaction,
            runResearchConnectionOperation} = connection.default ?? connection;
          const researchModule = await import('./src/services/research/research.repository.js');
          const paperModule = await import('./src/services/research/paperTrading/paperTrading.repository.js');
          const paperMath = await import('./src/features/BitcoinTracker/features/PaperTrading/utils/paperTrading.utils.js');
          const {createResearchRepository} = researchModule.default ?? researchModule;
          const {createPaperTradingRepository} = paperModule.default ?? paperModule;
          const {PAPER_TRADING_POLICY} = paperMath.default ?? paperMath;
          const first = createClient({url:process.env.CONNECTION_TEST_URL});
          const second = createClient({url:process.env.CONNECTION_TEST_URL});
          let external;
          try {
            await first.execute('CREATE TABLE counter(value INTEGER)');
            await first.execute('INSERT INTO counter VALUES (0)');
            await Promise.all(Array.from({length:20}, async () => {
              const transaction = await getResearchWriteTransaction(first);
              try {
                await transaction.execute('UPDATE counter SET value=value+1');
                await transaction.commit();
              } finally { transaction.close(); }
            }));
            assert.equal((await first.execute('SELECT value FROM counter')).rows[0].value,20);
            const held = await getResearchWriteTransaction(first);
            await held.execute('UPDATE counter SET value=value+1');
            const contender = getResearchWriteTransaction(second);
            await delay(20);
            await held.commit();
            const resumed = await contender;
            await resumed.execute('UPDATE counter SET value=value+1');
            await resumed.commit();
            // A body failure rolls back once, rather than being silently replayed.
            const rejected = await getResearchWriteTransaction(first);
            await rejected.execute('UPDATE counter SET value=999');
            rejected.close();
            const reader = await getResearchReadTransaction(first);
            const queued = runResearchConnectionOperation(first, () =>
              first.execute('UPDATE counter SET value=value+1'));
            assert.equal((await reader.execute('SELECT value FROM counter')).rows[0].value,22);
            await reader.commit();
            await queued;
            external = await getResearchWriteTransaction(second);
            await assert.rejects(getResearchWriteTransaction(first),{code:'SQLITE_BUSY'});
            await external.rollback();
            external = null;
            const recovered = await getResearchWriteTransaction(first);
            await recovered.execute('UPDATE counter SET value=value+1');
            await recovered.commit();
            assert.equal((await first.execute('SELECT value FROM counter')).rows[0].value,24);
            // Exercise the actual independent repository queues sharing the collector client.
            const research = createResearchRepository({client:first});
            const paper = createPaperTradingRepository({client:first});
            const now = Date.now();
            await research.getResearchStatus();
            await paper.ensurePolicy(PAPER_TRADING_POLICY,now);
            const activity = await Promise.all(Array.from({length:10},(_,index) => Promise.all([
              paper.readState(PAPER_TRADING_POLICY.id),
              paper.writeHeartbeat({policyId:PAPER_TRADING_POLICY.id,heartbeatAt:now,status:'running'}),
              research.acquireLearningLease({ownerId:'owner-'+index,now,expiresAt:now+60000}),
              research.getResearchStatus(),
            ])));
            assert.equal(activity.filter(result=>result[2]).length,1);
            assert.ok(activity.every(result=>result[3].writeAvailable));
            assert.equal((await paper.readState(PAPER_TRADING_POLICY.id)).decisions.length,0);
            assert.equal((await paper.readHeartbeat(PAPER_TRADING_POLICY.id)).status,'running');
            process.stdout.write('verified');
          } finally { external?.close(); first.close(); second.close(); }
        `,
      ],
      {
        windowsHide: true,
        encoding: 'utf8',
        env: {
          ...process.env,
          TSX_TSCONFIG_PATH: path.resolve('jsconfig.json'),
          CONNECTION_TEST_URL: pathToFileURL(path.join(directory, 'connection.db')).href,
        },
      },
    );
    expect(output).toBe('verified');
  } finally {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('bitcoin-connection-tests-')
    )
      throw new Error('Refusing cleanup outside the verified connection test directory.');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 30_000);
