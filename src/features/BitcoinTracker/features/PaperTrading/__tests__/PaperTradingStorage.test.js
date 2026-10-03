/** @jest-environment node */
import { createClient } from '@libsql/client';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPaperTradingRepository } from '@/services/research/paperTrading/paperTrading.repository';
import { KALSHI_OUTCOME_DEFINITION } from '../../../utils/kalshi/contract.utils';
import {
  PAPER_TRADING_POLICY,
  createPaperDecision,
  getPaperPortfolio,
  simulatePaperFill,
  settlePaperPosition,
} from '../utils/paperTrading.utils';

jest.mock('server-only', () => ({}), { virtual: true });

const START = Date.UTC(2026, 9, 3, 12);
const MINUTE = 60_000;
const clone = (value) => JSON.parse(JSON.stringify(value));
let clients;
let repository;
let clock;

function openRepository() {
  const client = clients[0] ?? createClient({ url: 'file::memory:' });
  if (!clients.length) clients.push(client);
  return createPaperTradingRepository({ client, now: () => clock });
}

function contractFor(index, capturedAt = clock) {
  return {
    ticker: `KXBTC15M-PAPER${index}`,
    eventTicker: `KXBTC15M-PAPER${index}`,
    seriesTicker: 'KXBTC15M',
    target: 100_000,
    startsAt: capturedAt - 9 * MINUTE,
    expiresAt: capturedAt + 6 * MINUTE,
    comparison: 'greater_or_equal',
    roundDigits: 2,
    rulesVerified: true,
    outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
  };
}

function bookFor(contract, time = clock) {
  return {
    ticker: contract.ticker,
    requestedAt: time,
    receivedAt: time,
    yesAsks: [{ price: 0.5, quantity: 100 }],
    noAsks: [{ price: 0.55, quantity: 100 }],
    fee: {
      available: true,
      type: 'quadratic',
      multiplier: 1,
      checkedAt: time,
      validUntil: time + 30_000,
    },
    depthLimit: 100,
  };
}

function decisionFor(index, { policy = PAPER_TRADING_POLICY, portfolio, forecast = {} } = {}) {
  const contract = contractFor(index);
  return createPaperDecision({
    contract,
    policy,
    now: clock,
    portfolio: portfolio ?? getPaperPortfolio({ policy, now: clock }),
    forecast: {
      available: true,
      aboveProbability: 0.85,
      capturedAt: clock,
      modelVersion: 'kalshi-brti-derivatives-v2',
      modelId: null,
      ...forecast,
    },
    book: bookFor(contract),
  });
}

async function enroll(policy = PAPER_TRADING_POLICY) {
  await repository.ensurePolicy(policy, START);
  clock = START + 9 * MINUTE;
}

async function fillDecision(decision) {
  clock = decision.decidedAt + decision.policy.minimumFillDelayMs;
  expect(
    await repository.claimExecutionAttempt({ decisionId: decision.id, requestedAt: clock }),
  ).toBe(true);
  const fill = simulatePaperFill({ decision, book: bookFor(decision.contract), now: clock });
  expect(fill.kind).toBe('fill');
  await repository.saveEvent(fill);
  return fill;
}

function settlementFor(decision, fill, result = 'yes') {
  clock = decision.contract.expiresAt + 1000;
  return settlePaperPosition({
    decision,
    fill,
    now: clock,
    market: {
      ...decision.contract,
      status: 'settled',
      result,
      settlementPrice: result === 'yes' ? 100_100 : 99_900,
      settledAt: clock,
      receivedAt: clock,
    },
  });
}

beforeEach(() => {
  clients = [];
  clock = START;
  repository = openRepository();
});

afterEach(() => {
  for (const client of clients) client.close();
});

test('report reads leave the policy unstarted and enrollment preserves its first boundary', async () => {
  expect(await repository.readState(PAPER_TRADING_POLICY.id)).toEqual({
    policy: null,
    startedAt: null,
    decisions: [],
    events: [],
  });
  expect(await repository.readHeartbeat(PAPER_TRADING_POLICY.id)).toBeNull();
  expect(await repository.ensurePolicy(PAPER_TRADING_POLICY, START)).toEqual({
    policy: PAPER_TRADING_POLICY,
    startedAt: START,
  });
  clock += MINUTE;
  expect(await openRepository().ensurePolicy({ ...PAPER_TRADING_POLICY }, clock)).toEqual({
    policy: PAPER_TRADING_POLICY,
    startedAt: START,
  });
  await expect(
    repository.ensurePolicy({ ...PAPER_TRADING_POLICY, maxOpenRisk: 4 }, clock),
  ).rejects.toMatchObject({ code: 'PAPER_RECORD_CONFLICT' });
});

test('decisions and executions survive restart and exact retries cannot spend twice', async () => {
  await enroll();
  const decision = decisionFor(1);
  expect(decision.status).toBe('intent');
  expect(await repository.saveDecision(decision)).toEqual(decision);
  expect(await repository.saveDecision({ ...decision })).toEqual(decision);
  const fill = await fillDecision(decision);
  repository = openRepository();
  expect(await repository.saveDecision(decision)).toEqual(decision);
  expect(await repository.saveEvent(fill)).toEqual(fill);
  await expect(repository.saveEvent({ ...fill, cost: fill.cost + 0.01 })).rejects.toMatchObject({
    code: 'PAPER_RECORD_CONFLICT',
  });
  const state = await repository.readState(PAPER_TRADING_POLICY.id);
  expect(state.decisions).toEqual([decision]);
  expect(state.events).toEqual([fill]);
  expect(getPaperPortfolio({ ...state, now: clock })).toMatchObject({
    cash: PAPER_TRADING_POLICY.initialBankroll - fill.totalCost,
    openRisk: fill.totalCost,
    pendingIntentCount: 0,
    openPositionCount: 1,
  });
});

test('full replay inputs remain archived while routine state reads omit them', async () => {
  await enroll();
  const decision = decisionFor(1, {
    forecast: { researchInputSnapshot: { version: 'test-archive', data: 'x'.repeat(160_000) } },
  });
  await repository.saveDecision(decision);
  const state = await repository.readState(PAPER_TRADING_POLICY.id);
  expect(state.decisions[0].forecast.researchInputSnapshot).toBeUndefined();
  expect(state.decisions[0].forecast.aboveProbability).toBe(decision.forecast.aboveProbability);
  expect(await repository.readDecision(decision.id)).toEqual(decision);
  expect(
    (await repository.readState(PAPER_TRADING_POLICY.id, { includeInputs: true })).decisions,
  ).toEqual([decision]);
  expect(await repository.readDecision('absent')).toBeNull();
});

test('corrupt compact evidence cannot disappear from a portfolio or release reserved cash', async () => {
  await enroll();
  const decision = decisionFor(1);
  await repository.saveDecision(decision);
  await expect(
    clients[0].execute({
      sql: 'DELETE FROM paper_decisions WHERE id = ?',
      args: [decision.id],
    }),
  ).rejects.toThrow('append-only');
  // Simulate an externally damaged summary without altering the original input archive.
  await clients[0].execute('DROP TRIGGER paper_decisions_immutable_update');
  await clients[0].execute({
    sql: "UPDATE paper_decisions SET summary_payload = json_set(summary_payload, '$.reservedCapital', 0) WHERE id = ?",
    args: [decision.id],
  });
  await expect(repository.readState(PAPER_TRADING_POLICY.id)).rejects.toMatchObject({
    code: 'PAPER_STORAGE_CORRUPT',
  });
  await expect(repository.saveDecision(decisionFor(2))).rejects.toMatchObject({
    code: 'PAPER_STORAGE_CORRUPT',
  });
  expect(await repository.readDecision(decision.id)).toEqual(decision);
});

test('one policy and contract has one immutable decision, including recorded skips', async () => {
  await enroll();
  const decision = decisionFor(1, { forecast: { available: false } });
  expect(decision.status).toBe('skipped');
  await repository.saveDecision(decision);
  await expect(repository.saveDecision(decisionFor(1))).rejects.toMatchObject({
    code: 'PAPER_RECORD_CONFLICT',
  });
  expect((await repository.readState(PAPER_TRADING_POLICY.id)).decisions).toEqual([decision]);
  expect(
    getPaperPortfolio({ policy: PAPER_TRADING_POLICY, decisions: [decision], now: clock }).cash,
  ).toBe(100);
});

test('intents must belong to an enrolled policy and cannot be backdated or future dated', async () => {
  clock = START + 9 * MINUTE;
  const decision = decisionFor(1);
  await expect(repository.saveDecision(decision)).rejects.toMatchObject({
    code: 'PAPER_POLICY_NOT_STARTED',
  });
  await repository.ensurePolicy(PAPER_TRADING_POLICY, clock);
  clock -= 1;
  await expect(repository.saveDecision(decision)).rejects.toMatchObject({
    code: 'PAPER_RECORD_INVALID',
  });
  clock += 1;
  const older = createPaperDecision({
    contract: contractFor(2, clock - 1000),
    policy: PAPER_TRADING_POLICY,
    now: clock - 1000,
    portfolio: { cash: 100, openRisk: 0, dailyRealizedPnl: 0 },
    forecast: { ...decision.forecast, capturedAt: clock - 1000 },
    book: bookFor(contractFor(2, clock - 1000), clock - 1000),
  });
  await expect(repository.saveDecision(older)).rejects.toMatchObject({
    code: 'PAPER_RECORD_INVALID',
  });
  expect((await repository.readState(PAPER_TRADING_POLICY.id)).decisions).toHaveLength(0);
});

test('concurrent writers cannot reserve the same remaining risk budget', async () => {
  const policy = { ...PAPER_TRADING_POLICY, maxOpenRisk: 1 };
  await enroll(policy);
  const other = openRepository();
  await other.initialize();
  const decisions = [decisionFor(1, { policy }), decisionFor(2, { policy })];
  const results = await Promise.allSettled([
    repository.saveDecision(decisions[0]),
    other.saveDecision(decisions[1]),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.findIndex((result) => result.status === 'rejected');
  await expect(other.saveDecision(decisions[rejected])).rejects.toMatchObject({
    code: 'PAPER_CAPITAL_CHANGED',
  });
  const state = await repository.readState(policy.id);
  expect(state.decisions).toHaveLength(1);
  const portfolio = getPaperPortfolio({ ...state, now: clock });
  expect(portfolio.openRisk).toBeLessThanOrEqual(policy.maxOpenRisk);
  const skipped = decisionFor(3, { policy, portfolio });
  expect(skipped).toMatchObject({ status: 'skipped', reason: 'open_risk_limit' });
  await other.saveDecision(skipped);
  expect(getPaperPortfolio({ ...(await repository.readState(policy.id)), now: clock })).toEqual(
    portfolio,
  );
});

test.each([
  ['cash', { initialBankroll: 1, maxOpenRisk: 1, maxDailyLoss: 1 }, 'insufficient_cash'],
  ['daily loss', { maxDailyLoss: 0.5 }, 'daily_loss_limit'],
])('a settled loss enforces the %s cap against a stale decision', async (_name, limits, reason) => {
  const policy = { ...PAPER_TRADING_POLICY, ...limits };
  await enroll(policy);
  const first = decisionFor(1, { policy });
  await repository.saveDecision(first);
  const fill = await fillDecision(first);
  await repository.saveEvent(settlementFor(first, fill, 'no'));
  clock += 9 * MINUTE;
  await expect(repository.saveDecision(decisionFor(2, { policy }))).rejects.toMatchObject({
    code: 'PAPER_CAPITAL_CHANGED',
  });
  const portfolio = getPaperPortfolio({ ...(await repository.readState(policy.id)), now: clock });
  const skipped = decisionFor(2, { policy, portfolio });
  expect(skipped).toMatchObject({ status: 'skipped', reason });
  await repository.saveDecision(skipped);
});

test('only one execution can finish an intent and no-fill releases its reservation', async () => {
  await enroll();
  const decision = decisionFor(1);
  await repository.saveDecision(decision);
  clock += PAPER_TRADING_POLICY.maximumFillDelayMs + 1;
  const noFill = simulatePaperFill({ decision, book: null, now: clock });
  await repository.saveEvent(noFill);
  expect(await repository.saveEvent(noFill)).toEqual(noFill);
  const fillAt = decision.decidedAt + PAPER_TRADING_POLICY.minimumFillDelayMs;
  const changed = simulatePaperFill({
    decision,
    book: bookFor(decision.contract, fillAt),
    now: fillAt,
  });
  await expect(repository.saveEvent(changed)).rejects.toMatchObject({
    code: 'PAPER_RECORD_CONFLICT',
  });
  const state = await repository.readState(PAPER_TRADING_POLICY.id);
  expect(getPaperPortfolio({ ...state, now: clock })).toMatchObject({
    cash: 100,
    openRisk: 0,
    reservedCapital: 0,
  });
});

test('settlement requires its saved fill and matching finalized official outcome', async () => {
  await enroll();
  const decision = decisionFor(1);
  await repository.saveDecision(decision);
  clock += PAPER_TRADING_POLICY.minimumFillDelayMs;
  await repository.claimExecutionAttempt({ decisionId: decision.id, requestedAt: clock });
  const fill = simulatePaperFill({ decision, book: bookFor(decision.contract), now: clock });
  const settled = settlementFor(decision, fill);
  await expect(repository.saveEvent(settled)).rejects.toMatchObject({
    code: 'PAPER_RECORD_INVALID',
  });
  await repository.saveEvent(fill);
  const changed = clone(settled);
  changed.market.target += 1;
  await expect(repository.saveEvent(changed)).rejects.toMatchObject({
    code: 'PAPER_RECORD_INVALID',
  });
  const unfinalized = clone(settled);
  unfinalized.market.status = 'determined';
  await expect(repository.saveEvent(unfinalized)).rejects.toMatchObject({
    code: 'PAPER_RECORD_INVALID',
  });
  expect(await repository.saveEvent(settled)).toEqual(settled);
  expect(await openRepository().saveEvent(settled)).toEqual(settled);
  expect(
    getPaperPortfolio({ ...(await repository.readState(PAPER_TRADING_POLICY.id)), now: clock }),
  ).toMatchObject({ openRisk: 0, settledCount: 1, realizedPnl: settled.netPnl });
});

test('future or altered execution inputs cannot spend the reservation', async () => {
  await enroll();
  const decision = decisionFor(1);
  await repository.saveDecision(decision);
  const fillAt = clock + PAPER_TRADING_POLICY.minimumFillDelayMs;
  const fill = simulatePaperFill({
    decision,
    book: bookFor(decision.contract, fillAt),
    now: fillAt,
  });
  await expect(repository.saveEvent(fill)).rejects.toMatchObject({ code: 'PAPER_RECORD_INVALID' });
  clock = fillAt;
  await repository.claimExecutionAttempt({ decisionId: decision.id, requestedAt: clock });
  const changed = clone(fill);
  changed.totalCost = decision.reservedCapital + 1;
  await expect(repository.saveEvent(changed)).rejects.toMatchObject({
    code: 'PAPER_RECORD_INVALID',
  });
  expect((await repository.readState(PAPER_TRADING_POLICY.id)).events).toHaveLength(0);
  await repository.saveEvent(fill);
});

test('a durable execution claim survives restart and permits only the first book attempt', async () => {
  await enroll();
  const decision = decisionFor(1);
  await repository.saveDecision(decision);
  clock += decision.policy.minimumFillDelayMs;
  const request = { decisionId: decision.id, requestedAt: clock };
  expect(await repository.claimExecutionAttempt(request)).toBe(true);
  repository = openRepository();
  expect(await repository.claimExecutionAttempt(request)).toBe(false);
  clock += 1;
  expect(await repository.claimExecutionAttempt({ ...request, requestedAt: clock })).toBe(false);
  expect(
    (await repository.readState(PAPER_TRADING_POLICY.id, { includeAttempts: true })).attempts,
  ).toEqual([request]);
  // After an unknown request outcome, record no-fill instead of fetching another price.
  const noFill = simulatePaperFill({ decision, book: null, now: clock });
  await repository.saveEvent(noFill);
  expect(
    getPaperPortfolio({ ...(await repository.readState(PAPER_TRADING_POLICY.id)), now: clock }),
  ).toMatchObject({ cash: 100, openRisk: 0 });
});

test('fills require a saved causal request and cannot use a book obtained before the claim', async () => {
  await enroll();
  const decision = decisionFor(1);
  await repository.saveDecision(decision);
  clock += decision.policy.minimumFillDelayMs;
  const fill = simulatePaperFill({ decision, book: bookFor(decision.contract), now: clock });
  await expect(repository.saveEvent(fill)).rejects.toMatchObject({ code: 'PAPER_RECORD_INVALID' });
  clock += 1;
  await repository.claimExecutionAttempt({ decisionId: decision.id, requestedAt: clock });
  await expect(repository.saveEvent(fill)).rejects.toMatchObject({ code: 'PAPER_RECORD_INVALID' });
  const causal = simulatePaperFill({ decision, book: bookFor(decision.contract), now: clock });
  await repository.saveEvent(causal);
  expect((await repository.readState(PAPER_TRADING_POLICY.id)).events).toEqual([causal]);
});

test('request claims reject missing intents and times outside the execution window', async () => {
  await enroll();
  const decision = decisionFor(1);
  await expect(
    repository.claimExecutionAttempt({ decisionId: decision.id, requestedAt: clock }),
  ).rejects.toMatchObject({ code: 'PAPER_RECORD_INVALID' });
  await repository.saveDecision(decision);
  await expect(
    repository.claimExecutionAttempt({ decisionId: decision.id, requestedAt: clock }),
  ).rejects.toMatchObject({ code: 'PAPER_RECORD_INVALID' });
  await expect(
    repository.claimExecutionAttempt({
      decisionId: decision.id,
      requestedAt: clock + decision.policy.minimumFillDelayMs,
    }),
  ).rejects.toMatchObject({ code: 'PAPER_RECORD_INVALID' });
  clock += decision.policy.maximumFillDelayMs + 1;
  await expect(
    repository.claimExecutionAttempt({ decisionId: decision.id, requestedAt: clock }),
  ).rejects.toMatchObject({ code: 'PAPER_RECORD_INVALID' });
  expect(
    (await repository.readState(PAPER_TRADING_POLICY.id, { includeAttempts: true })).attempts,
  ).toEqual([]);
  await repository.saveEvent(simulatePaperFill({ decision, book: null, now: clock }));
});

test('heartbeats cannot move backward and a same-time shutdown remains stopped', async () => {
  await enroll();
  const beat = { policyId: PAPER_TRADING_POLICY.id, heartbeatAt: clock, status: 'running' };
  await repository.writeHeartbeat(beat);
  const stopped = { ...beat, status: 'stopped' };
  await repository.writeHeartbeat(stopped);
  expect(await repository.writeHeartbeat(beat)).toEqual(stopped);
  expect(await repository.writeHeartbeat({ ...beat, heartbeatAt: clock - 1 })).toEqual(stopped);
  expect(await openRepository().readHeartbeat(PAPER_TRADING_POLICY.id)).toEqual(stopped);
  await expect(
    repository.writeHeartbeat({ ...beat, privatePath: '/private/test-path' }),
  ).rejects.toMatchObject({ code: 'PAPER_RECORD_INVALID' });
});

test('separate file clients reserve atomically and the ledger survives a process restart', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'bitcoin-paper-tests-'));
  const policy = { ...PAPER_TRADING_POLICY, maxOpenRisk: 1 };
  clock = START + 9 * MINUTE;
  const decisions = [decisionFor(1, { policy }), decisionFor(2, { policy })];
  const options = {
    windowsHide: true,
    encoding: 'utf8',
    env: {
      ...process.env,
      TSX_TSCONFIG_PATH: path.resolve('jsconfig.json'),
      PAPER_TEST_URL: pathToFileURL(path.join(directory, 'paper.db')).href,
      PAPER_TEST_INPUT: JSON.stringify({ policy, decisions, now: clock, startedAt: START }),
    },
  };
  const setup = `
    import assert from 'node:assert/strict';
    import {createClient} from '@libsql/client';
    const module = await import('./src/services/research/paperTrading/paperTrading.repository.js');
    const {createPaperTradingRepository} = module.default ?? module;
    const input = JSON.parse(process.env.PAPER_TEST_INPUT);
    const first = createClient({url:process.env.PAPER_TEST_URL});
    const firstRepository = createPaperTradingRepository({client:first,now:()=>input.now});
  `;
  const run = (source) =>
    execFileSync(
      process.execPath,
      ['--conditions=react-server', '--import', 'tsx', '--input-type=module', '-e', setup + source],
      options,
    );
  try {
    const saved = JSON.parse(
      run(`
      const second = createClient({url:process.env.PAPER_TEST_URL});
      const secondRepository = createPaperTradingRepository({client:second,now:()=>input.now});
      try {
        await firstRepository.ensurePolicy(input.policy,input.startedAt);
        await secondRepository.initialize();
        const results = await Promise.allSettled([
          firstRepository.saveDecision(input.decisions[0]),
          secondRepository.saveDecision(input.decisions[1]),
        ]);
        assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
        const rejected = results.findIndex(result=>result.status==='rejected');
        await assert.rejects(secondRepository.saveDecision(input.decisions[rejected]),{code:'PAPER_CAPITAL_CHANGED'});
        const state = await firstRepository.readState(input.policy.id);
        assert.equal(state.decisions.length,1);
        input.now += input.policy.minimumFillDelayMs;
        const attempt = {decisionId:state.decisions[0].id,requestedAt:input.now};
        const claims = await Promise.allSettled([
          firstRepository.claimExecutionAttempt(attempt),
          secondRepository.claimExecutionAttempt(attempt),
        ]);
        assert.equal(claims.filter(result=>result.status==='fulfilled'&&result.value===true).length,1);
        assert.equal(await secondRepository.claimExecutionAttempt(attempt),false);
        process.stdout.write(JSON.stringify(state));
      } finally { first.close(); second.close(); }
    `),
    );
    const restored = JSON.parse(
      run(`
      try {
        const state = await firstRepository.readState(input.policy.id);
        await firstRepository.saveDecision(state.decisions[0]);
        process.stdout.write(JSON.stringify(await firstRepository.readState(input.policy.id)));
      } finally { first.close(); }
    `),
    );
    expect(restored).toEqual(saved);
    expect(getPaperPortfolio({ ...restored, now: clock }).openRisk).toBeLessThanOrEqual(
      policy.maxOpenRisk,
    );
  } finally {
    const resolved = path.resolve(directory);
    if (
      path.dirname(resolved) !== path.resolve(os.tmpdir()) ||
      !path.basename(resolved).startsWith('bitcoin-paper-tests-')
    )
      throw new Error('Refusing cleanup outside the verified paper test directory.');
    await rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}, 30_000);
