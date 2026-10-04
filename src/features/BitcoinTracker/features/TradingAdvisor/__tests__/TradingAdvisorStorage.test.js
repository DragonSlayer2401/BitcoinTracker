/** @jest-environment node */
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTradingAdvisorRepository } from '@/services/research/tradingAdvisor/tradingAdvisor.repository';
import { getAdvisorPortfolio } from '@/services/research/tradingAdvisor/tradingAdvisor.ledger';
import { TRADING_ADVISOR_POLICY, getTradingAdvice } from '../utils/tradingAdvisor.utils';
import { START, contract, bookAt, forecastAt, outcomeAt } from './TradingAdvisor.fixtures';

jest.mock('server-only', () => ({}), { virtual: true });
const policy = TRADING_ADVISOR_POLICY;
let client;
let repository;
let clock;
let lease;
beforeEach(async () => {
  clock = START + 60_000;
  client = createClient({ url: 'file::memory:' });
  repository = createTradingAdvisorRepository({ client, now: () => clock });
  await repository.ensurePolicy(policy, START);
  lease = await repository.acquireLease(policy.id, 'test-owner');
});
afterEach(() => client.close());

async function saveAdvice(probability = 0.85, book = bookAt(clock)) {
  const state = await repository.readState(policy.id);
  const { researchInputSnapshot, ...forecast } = forecastAt(clock, probability);
  const portfolio = getAdvisorPortfolio(state.account, clock);
  const advice = {
    ...getTradingAdvice({ contract, forecast, book, portfolio, now: clock, policy }),
    id: `${policy.id}:${contract.ticker}:${clock}`,
    forecast,
    book,
    portfolio,
    accountVersion: state.account.version,
    validUntil: Math.min(clock + policy.cadenceMs, contract.expiresAt),
  };
  await repository.saveAdvice({ advice, researchInputSnapshot, lease });
  return advice;
}
async function fill(advice, book = null) {
  clock = advice.evaluatedAt + policy.minimumFillDelayMs;
  await repository.claimExecutionAttempt({ adviceId: advice.id, requestedAt: clock, lease });
  return repository.saveExecution({
    adviceId: advice.id,
    book: book ?? bookAt(clock),
    recordedAt: clock,
    observationAttemptToken: lease.token,
    lease,
  });
}
async function renew() {
  await repository.releaseLease(lease);
  lease = await repository.acquireLease(policy.id, 'test-owner');
}

test('saves immutable advice, compact summaries, compressed entry inputs and an atomic reservation', async () => {
  const advice = await saveAdvice();
  expect(advice.action).toBe('buy');
  const state = await repository.readState(policy.id);
  expect(state.account.cash).toBeCloseTo(100 - advice.maxCost, 8);
  expect(state.advice[0].book).toBeUndefined();
  const full = await repository.readAdvice(advice.id, { includeInputs: true });
  expect(full.forecast.researchInputSnapshot.timing.replayable).toBe(true);
  await expect(
    repository.saveAdvice({ advice: { ...advice, quantity: advice.quantity + 1 }, lease }),
  ).rejects.toThrow();
  await expect(client.execute('DELETE FROM advisor_advice')).rejects.toThrow('append-only');
  const second = createTradingAdvisorRepository({ client, now: () => clock });
  expect((await second.readState(policy.id)).account).toEqual(state.account);
});

test('wait observations preserve adviser inputs without duplicating full model snapshots', async () => {
  const advice = await saveAdvice(0.5);
  expect(advice.action).toBe('wait');
  const full = await repository.readAdvice(advice.id, { includeInputs: true });
  expect(full.book).toEqual(bookAt(clock));
  expect(full.forecast.researchInputSnapshot).toBeUndefined();
  expect(full.portfolio.cash).toBe(100);
  expect((await repository.readState(policy.id)).account.performance.waitCount).toBe(1);
});

test('records prospective account marks without changing cash or rewriting earlier evidence', async () => {
  const advice = await saveAdvice();
  let state = await repository.readState(policy.id);
  expect(state.risk.valuation).toMatchObject({
    complete: true,
    executableEquity: 100,
    totalMarkedPnl: 0,
    accountVersion: state.account.version,
    sourceId: advice.id,
    sourceKind: 'advice',
  });
  expect(state.risk.history.completeCount).toBe(1);
  const initialMark = state.risk.valuation;
  const execution = await fill(advice);
  state = await repository.readState(policy.id);
  expect(state.risk.valuation.sourceId).toBe(execution.id);
  expect(state.risk.valuation.accountVersion).toBe(state.account.version);
  expect(state.risk.valuation.executableEquity).toBeLessThan(100);
  expect(state.risk.valuation.executableEquity).toBeCloseTo(
    state.account.cash + state.risk.valuation.liquidationValue,
    6,
  );
  expect(state.risk.valuation.unrealizedPnl).toBeLessThan(0);
  expect(state.account.realizedPnl).toBe(0);
  expect(state.risk.history.maxDrawdown).toBeGreaterThan(0);
  const marks = await repository.readEvidencePage(policy.id, { kind: 'valuations' });
  expect(marks).toHaveLength(2);
  expect(marks[0].value).toEqual(initialMark);
  const restarted = createTradingAdvisorRepository({ client, now: () => clock });
  expect((await restarted.readState(policy.id)).risk).toEqual(state.risk);
  await expect(client.execute('DELETE FROM advisor_valuations')).rejects.toThrow('append-only');
});

test('valuation persistence failure rolls back the related reservation and advice together', async () => {
  await client.execute(`CREATE TRIGGER fail_test_valuation BEFORE INSERT ON advisor_valuations
    BEGIN SELECT RAISE(ABORT, 'test valuation failure'); END`);
  await expect(saveAdvice()).rejects.toThrow('test valuation failure');
  const state = await repository.readState(policy.id);
  expect(state.account.cash).toBe(100);
  expect(state.account.pendingIntents).toHaveLength(0);
  expect(state.advice).toHaveLength(0);
  expect(state.risk).toBeNull();
});

test('thin exit depth leaves the account value unknown without hiding its committed capital', async () => {
  const advice = await saveAdvice();
  await fill(advice);
  clock = advice.evaluatedAt + policy.cadenceMs;
  await saveAdvice(0.85, { ...bookAt(clock), noAsks: [{ price: 0.55, quantity: 1 }] });
  const state = await repository.readState(policy.id);
  expect(state.risk.valuation).toMatchObject({
    complete: false,
    executableEquity: null,
    unrealizedPnl: null,
    unpricedPositionCount: 1,
    worstCaseFinalCash: state.account.cash,
  });
  expect(state.risk.valuation.committedCapitalAtRisk).toBeGreaterThan(0);
  expect(state.risk.history.incompleteCount).toBe(1);
  expect(state.risk.history.maxDrawdown).toBeGreaterThan(0);
});

test('a partial sale cannot reuse consumed bids to inflate the remaining position value', async () => {
  const entry = await saveAdvice();
  await fill(entry);
  clock = entry.evaluatedAt + policy.cadenceMs;
  const exitBook = {
    ...bookAt(clock),
    yesAsks: [{ price: 0.9, quantity: 100 }],
    noAsks: [
      { price: 0.2, quantity: 3 },
      { price: 0.8, quantity: 100 },
    ],
  };
  const exit = await saveAdvice(0.3, exitBook);
  expect(exit).toMatchObject({ action: 'sell', quantity: 3 });
  await fill(exit, { ...exitBook, requestedAt: clock + 2000, receivedAt: clock + 2000 });
  const state = await repository.readState(policy.id);
  expect(state.account.positions[0].quantity).toBe(entry.quantity - 3);
  expect(state.risk.valuation.complete).toBe(false);
  expect(state.risk.valuation.executableEquity).toBeNull();
  expect(state.risk.valuation.positions[0].status).toBe('book_unavailable');
  clock = exit.evaluatedAt + policy.cadenceMs;
  await saveAdvice(0.3, { ...bookAt(clock), noAsks: [{ price: 0.8, quantity: 100 }] });
  expect((await repository.readState(policy.id)).risk.valuation.complete).toBe(true);
});

test('a lease fences other writers and expiration never authorizes an old writer', async () => {
  expect(await repository.acquireLease(policy.id, 'another-owner')).toBeNull();
  const old = lease;
  clock += 60001;
  lease = await repository.acquireLease(policy.id, 'another-owner');
  expect(lease.token).not.toBe(old.token);
  await expect(
    repository.writeHeartbeat({ policyId: policy.id, status: 'running', heartbeatAt: clock }, old),
  ).rejects.toMatchObject({ code: 'ADVISOR_LEASE_LOST' });
  await repository.releaseLease(old);
  expect(await repository.acquireLease(policy.id, 'third-owner')).toBeNull();
});

test('execution claims are durable and an interrupted expired attempt becomes one no-fill', async () => {
  const advice = await saveAdvice();
  clock += 2000;
  expect(
    await repository.claimExecutionAttempt({ adviceId: advice.id, requestedAt: clock, lease }),
  ).toBe(true);
  expect(
    await repository.claimExecutionAttempt({ adviceId: advice.id, requestedAt: clock, lease }),
  ).toBe(false);
  clock += 61000;
  lease = await repository.acquireLease(policy.id, 'restart-owner');
  const event = await repository.saveExecution({
    adviceId: advice.id,
    book: null,
    recordedAt: clock,
    lease,
  });
  expect(event.kind).toBe('no-fill');
  expect((await repository.readState(policy.id)).account.cash).toBe(100);
  await repository.saveExecution({ adviceId: advice.id, book: null, recordedAt: clock, lease });
  expect((await repository.readState(policy.id)).account.performance.noFillCount).toBe(1);
});

test('expired response recovery still rejects another owner or an unrelated request claim', async () => {
  const advice = await saveAdvice();
  clock += 2000;
  await repository.claimExecutionAttempt({ adviceId: advice.id, requestedAt: clock, lease });
  const originalToken = lease.token;
  const requestedAt = clock;
  clock += 61000;
  const book = { ...bookAt(clock), requestedAt };
  lease = await repository.acquireLease(policy.id, 'another-owner');
  await expect(
    repository.saveExecution({
      adviceId: advice.id,
      book,
      recordedAt: clock,
      observationAttemptToken: originalToken,
      lease,
    }),
  ).rejects.toThrow('original durable request claim');
  await renew();
  await expect(
    repository.saveExecution({
      adviceId: advice.id,
      book,
      recordedAt: clock,
      observationAttemptToken: 'unrelated-token',
      lease,
    }),
  ).rejects.toThrow('original durable request claim');
  const state = await repository.readState(policy.id);
  expect(state.account.pendingIntents).toHaveLength(1);
  expect(state.account.performance.noFillCount).toBe(0);
});

test('fills once, sells a partial position with proportional costs, settles the remainder and scores paired holding', async () => {
  const entry = await saveAdvice();
  const buy = await fill(entry);
  expect(buy.kind).toBe('fill');
  const positionId = `${entry.id}:position`;
  clock = entry.evaluatedAt + policy.cadenceMs;
  const exitBook = { ...bookAt(clock), noAsks: [{ price: 0.55, quantity: 3 }] };
  const exit = await saveAdvice(0.2, exitBook);
  expect(exit).toMatchObject({ action: 'sell', quantity: 3, positionId });
  const sell = await fill(exit, {
    ...exitBook,
    requestedAt: clock + 2000,
    receivedAt: clock + 2000,
  });
  expect(sell.kind).toBe('fill');
  const partial = (await repository.readState(policy.id)).account;
  expect(partial.positions[0].quantity).toBe(entry.quantity - 3);
  expect(partial.realizedPnl).toBeCloseTo(
    sell.netProceeds - (buy.totalCost * 3) / entry.quantity,
    7,
  );
  clock = contract.expiresAt + 1000;
  await renew();
  const market = outcomeAt(clock);
  expect(
    await repository.saveSettlement({
      policyId: policy.id,
      positionId,
      market: { ...market, target: 75001 },
      recordedAt: clock,
      lease,
    }),
  ).toBeNull();
  const settled = await repository.saveSettlement({
    policyId: policy.id,
    positionId,
    market,
    recordedAt: clock,
    lease,
  });
  expect(settled.quantity).toBe(entry.quantity - 3);
  const comparison = await repository.saveComparison({
    policyId: policy.id,
    positionId,
    market,
    recordedAt: clock,
    lease,
  });
  expect(comparison.holdPnl).toBeCloseTo(entry.quantity - buy.totalCost, 7);
  expect(comparison.strategyPnl).toBeCloseTo(
    sell.netProceeds + entry.quantity - 3 - buy.totalCost,
    7,
  );
  const final = (await repository.readState(policy.id)).account;
  expect(final.positions).toHaveLength(0);
  expect(final.pendingComparisons).toHaveLength(0);
  expect(final.cash).toBeCloseTo(100 + final.realizedPnl, 7);
  expect(final.performance.pairedPositionCount).toBe(1);
});

test('fully exited positions retain their original hold comparator until official settlement', async () => {
  const entry = await saveAdvice();
  const buy = await fill(entry);
  clock = entry.evaluatedAt + policy.cadenceMs;
  const exit = await saveAdvice(0.2);
  const sell = await fill(exit);
  expect(exit.quantity).toBe(entry.quantity);
  const before = (await repository.readState(policy.id)).account;
  expect(before.positions).toHaveLength(0);
  expect(before.pendingComparisons).toHaveLength(1);
  expect(before.performance.pairedPositionCount).toBe(0);
  clock = contract.expiresAt + 1000;
  await renew();
  await repository.saveComparison({
    policyId: policy.id,
    positionId: `${entry.id}:position`,
    market: outcomeAt(clock, 'no'),
    recordedAt: clock,
    lease,
  });
  const result = (await repository.readState(policy.id)).account.performance;
  expect(result.pairedStrategyPnl).toBeCloseTo(sell.netProceeds - buy.totalCost, 7);
  expect(result.pairedHoldPnl).toBeCloseTo(-buy.totalCost, 7);
});

test('rejects modified financial advice and overselling against a fresh portfolio', async () => {
  const entry = await saveAdvice();
  await fill(entry);
  clock = entry.evaluatedAt + policy.cadenceMs;
  const state = await repository.readState(policy.id);
  const portfolio = getAdvisorPortfolio(state.account, clock);
  const { researchInputSnapshot, ...forecast } = forecastAt(clock, 0.2);
  const output = getTradingAdvice({
    contract,
    forecast,
    portfolio,
    book: bookAt(clock),
    now: clock,
  });
  await expect(
    repository.saveAdvice({
      advice: {
        ...output,
        id: 'oversell',
        quantity: entry.quantity + 1,
        forecast,
        book: bookAt(clock),
        portfolio,
        accountVersion: state.account.version,
      },
      researchInputSnapshot,
      lease,
    }),
  ).rejects.toThrow();
  expect((await repository.readState(policy.id)).account.positions[0].quantity).toBe(
    entry.quantity,
  );
});

test('cannot settle with an unfinalized market or alter an enrolled policy', async () => {
  const entry = await saveAdvice();
  await fill(entry);
  clock = contract.expiresAt + 1000;
  await renew();
  expect(
    await repository.saveSettlement({
      policyId: policy.id,
      positionId: `${entry.id}:position`,
      market: { ...outcomeAt(clock), status: 'determined' },
      recordedAt: clock,
      lease,
    }),
  ).toBeNull();
  await expect(
    repository.ensurePolicy({ ...policy, probabilityReserve: 0.06 }, clock),
  ).rejects.toThrow();
});

test('retroactive execution accounting cannot rewind the account day or overwrite newer advice', async () => {
  const entry = await saveAdvice();
  clock += 2000;
  await repository.claimExecutionAttempt({ adviceId: entry.id, requestedAt: clock, lease });
  const oldTime = clock;
  const oldBook = bookAt(clock);
  clock = entry.evaluatedAt + policy.cadenceMs;
  const waiting = await saveAdvice();
  expect(waiting.reason).toBe('pending_execution');
  await expect(
    repository.saveExecution({
      adviceId: entry.id,
      book: oldBook,
      recordedAt: oldTime,
      observationAttemptToken: lease.token,
      lease,
    }),
  ).rejects.toThrow('chronological');
  expect((await repository.readState(policy.id)).account.pendingIntents).toHaveLength(1);
});

test('missing or corrupted materialized accounts fail closed instead of reporting a new $100 balance', async () => {
  await client.execute({
    sql: 'UPDATE advisor_accounts SET payload = ? WHERE policy_id = ?',
    args: ['{"cash":1000000}', policy.id],
  });
  await expect(repository.readState(policy.id)).rejects.toMatchObject({
    code: 'ADVISOR_STORAGE_CORRUPT',
  });
  await client.execute({
    sql: 'DELETE FROM advisor_accounts WHERE policy_id = ?',
    args: [policy.id],
  });
  await expect(repository.readState(policy.id)).rejects.toMatchObject({
    code: 'ADVISOR_STORAGE_CORRUPT',
  });
});

test('bounded audit pages and compact state preserve old evidence without a growing full read', async () => {
  for (let index = 0; index < 55; index += 1) {
    if (index > 0) {
      clock += policy.cadenceMs;
      await renew();
    }
    await saveAdvice(0.5);
  }
  const state = await repository.readState(policy.id);
  expect(state.advice).toHaveLength(50);
  expect(state.account.performance.adviceCount).toBe(55);
  const first = await repository.readEvidencePage(policy.id, { limit: 30 });
  const second = await repository.readEvidencePage(policy.id, {
    afterSequence: first.at(-1).sequence,
    limit: 30,
  });
  expect(first.length + second.length).toBe(55);
});

test('idempotent schema initialization recovers from one local busy acquisition without duplicate records', async () => {
  const fresh = createTradingAdvisorRepository({ client, now: () => clock });
  const transaction = client.transaction.bind(client);
  const spy = jest
    .spyOn(client, 'transaction')
    .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }))
    .mockImplementation(transaction);
  await fresh.initialize();
  expect(spy).toHaveBeenCalledTimes(2);
  expect((await fresh.readState(policy.id)).account.cash).toBe(100);
  const count = await client.execute('SELECT COUNT(*) AS count FROM advisor_policies');
  expect(Number(count.rows[0].count)).toBe(1);
});

test('a busy read closes its snapshot before retrying and returns one consistent account', async () => {
  await saveAdvice(0.5);
  const transaction = client.transaction.bind(client);
  let failedRead;
  const spy = jest
    .spyOn(client, 'transaction')
    .mockImplementationOnce(async (mode) => {
      failedRead = await transaction(mode);
      jest
        .spyOn(failedRead, 'execute')
        .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }));
      return failedRead;
    })
    .mockImplementation(transaction);
  const state = await repository.readState(policy.id);
  expect(spy).toHaveBeenCalledTimes(2);
  expect(failedRead.closed).toBe(true);
  expect(state.account.performance.adviceCount).toBe(1);
  expect(state.advice).toHaveLength(1);
});

test('write acquisition retries before mutation but never reruns a failed write body', async () => {
  const transaction = client.transaction.bind(client);
  const spy = jest
    .spyOn(client, 'transaction')
    .mockRejectedValueOnce(Object.assign(new Error('locked'), { code: 'SQLITE_BUSY' }))
    .mockImplementation(transaction);
  await repository.writeHeartbeat(
    { policyId: policy.id, status: 'running', heartbeatAt: clock },
    lease,
  );
  expect(spy).toHaveBeenCalledTimes(2);
  expect((await repository.readHeartbeat(policy.id)).status).toBe('running');
  let writes = 0;
  spy.mockImplementationOnce(async (mode) => {
    const handle = await transaction(mode);
    const execute = handle.execute.bind(handle);
    jest.spyOn(handle, 'execute').mockImplementation(async (statement) => {
      if (statement.sql?.includes('INSERT INTO advisor_heartbeats')) {
        writes += 1;
        throw Object.assign(new Error('locked during mutation'), { code: 'SQLITE_BUSY' });
      }
      return execute(statement);
    });
    return handle;
  });
  await expect(
    repository.writeHeartbeat({ policyId: policy.id, status: 'error', heartbeatAt: clock }, lease),
  ).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
  expect(writes).toBe(1);
  expect((await repository.readHeartbeat(policy.id)).status).toBe('running');
});

test('local busy retries stop after five attempts while other database errors fail immediately', async () => {
  const transaction = client.transaction.bind(client);
  const spy = jest
    .spyOn(client, 'transaction')
    .mockRejectedValue(Object.assign(new Error('still locked'), { code: 'SQLITE_BUSY' }));
  await expect(repository.readState(policy.id)).rejects.toMatchObject({ code: 'SQLITE_BUSY' });
  expect(spy).toHaveBeenCalledTimes(5);
  spy
    .mockClear()
    .mockRejectedValueOnce(Object.assign(new Error('disk issue'), { code: 'SQLITE_IOERR' }))
    .mockImplementation(transaction);
  await expect(repository.readState(policy.id)).rejects.toMatchObject({ code: 'SQLITE_IOERR' });
  expect(spy).toHaveBeenCalledTimes(1);
});

test('independent file clients share one writer lease and account survives process restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bitcoin-advisor-tests-'));
  const options = {
    windowsHide: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: path.resolve('jsconfig.json'),
      ADVISOR_TEST_URL: pathToFileURL(path.join(directory, 'advisor.db')).href,
      ADVISOR_TEST_INPUT: JSON.stringify({ policy, now: clock }),
    },
  };
  const setup = `
    import assert from 'node:assert/strict';
    import {createClient} from '@libsql/client';
    const module = await import('./src/services/research/tradingAdvisor/tradingAdvisor.repository.js');
    const {createTradingAdvisorRepository} = module.default ?? module;
    const input = JSON.parse(process.env.ADVISOR_TEST_INPUT);
    const client = createClient({url:process.env.ADVISOR_TEST_URL});
    const repository = createTradingAdvisorRepository({client,now:()=>input.now});
  `;
  const run = (source) =>
    execFileSync(
      process.execPath,
      ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', setup + source],
      options,
    );
  try {
    const original = JSON.parse(
      run(`
      const secondClient = createClient({url:process.env.ADVISOR_TEST_URL});
      const second = createTradingAdvisorRepository({client:secondClient,now:()=>input.now});
      try {
        await repository.ensurePolicy(input.policy,input.now);
        await second.initialize();
        const lease = await repository.acquireLease(input.policy.id,'first');
        assert(lease);
        assert.equal(await second.acquireLease(input.policy.id,'second'),null);
        const state = await second.readState(input.policy.id);
        // Reader completion must release its native transaction before another client writes.
        for (let index = 0; index < 10; index += 1) {
          await second.readState(input.policy.id);
          await repository.writeHeartbeat({policyId:input.policy.id,status:'running',heartbeatAt:input.now},lease);
        }
        process.stdout.write(JSON.stringify(state));
      } finally { client.close(); secondClient.close(); }
    `),
    );
    const restored = JSON.parse(
      run(`
      try {
        assert.equal(await repository.acquireLease(input.policy.id,'restart'),null);
        process.stdout.write(JSON.stringify(await repository.readState(input.policy.id)));
      } finally { client.close(); }
    `),
    );
    expect(restored).toEqual(original);
    expect(restored.account.cash).toBe(100);
  } finally {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('bitcoin-advisor-tests-')
    )
      throw new Error('Refusing cleanup outside the verified advisor test directory.');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 30000);
