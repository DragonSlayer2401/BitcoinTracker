/** @jest-environment node */
import { createPaperTradingService } from '@/services/research/paperTrading/paperTrading.service';
import { createPaperTradingRepository } from '@/services/research/paperTrading/paperTrading.repository';
import { createClient } from '@libsql/client';
import { PAPER_TRADING_POLICY } from '../utils/paperTrading.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../../../utils/kalshi/contract.utils';

jest.mock('server-only', () => ({}));

const start = 1_800_000_000_000;
const checkpoint = start + 540_000;
const contract = {
  ticker: 'KXBTC15M-PAPER-SERVICE',
  eventTicker: 'KXBTC15M-PAPER',
  seriesTicker: 'KXBTC15M',
  target: 100_000,
  startsAt: start,
  expiresAt: start + 900_000,
  comparison: 'greater_or_equal',
  roundDigits: 2,
  rulesVerified: true,
  outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
};

function setup() {
  let time = checkpoint;
  const state = { policy: null, startedAt: null, decisions: [], events: [] };
  let heartbeat = null;
  const attempts = new Set();
  const repository = {
    ensurePolicy: jest.fn(async (policy, startedAt) => {
      if (!state.policy) Object.assign(state, { policy, startedAt });
    }),
    readState: jest.fn(async () => structuredClone(state)),
    saveDecision: jest.fn(async (decision) => {
      if (!state.decisions.some((row) => row.id === decision.id))
        state.decisions.push(structuredClone(decision));
      return decision;
    }),
    saveEvent: jest.fn(async (event) => {
      if (!state.events.some((row) => row.id === event.id))
        state.events.push(structuredClone(event));
      return event;
    }),
    writeHeartbeat: jest.fn(async (value) => {
      heartbeat = value;
    }),
    readHeartbeat: jest.fn(async () => heartbeat),
    claimExecutionAttempt: jest.fn(async ({ decisionId }) => {
      if (attempts.has(decisionId)) return false;
      attempts.add(decisionId);
      return true;
    }),
  };
  const getForecast = jest.fn(() => ({
    available: true,
    aboveProbability: 0.8,
    capturedAt: time,
    modelVersion: 'test-production-v1',
    modelId: null,
  }));
  const loadBook = jest.fn(async () => ({
    ticker: contract.ticker,
    receivedAt: time,
    yesAsks: [{ price: 0.4, quantity: 10 }],
    noAsks: [{ price: 0.61, quantity: 10 }],
    fee: {
      available: true,
      type: 'quadratic',
      multiplier: 1,
      checkedAt: time,
      validUntil: time + 30_000,
    },
  }));
  const loadMarket = jest.fn(async () => ({
    ...contract,
    status: 'settled',
    result: 'yes',
    settlementPrice: 100_001,
    settledAt: contract.expiresAt,
    receivedAt: time,
  }));
  const options = { repository, loadBook, loadMarket, now: () => time };
  return {
    repository,
    state,
    loadBook,
    loadMarket,
    getForecast,
    options,
    service: createPaperTradingService(options),
    advanceTime: (amount) => {
      time += amount;
    },
  };
}

test('report-only access never enrolls a policy, fetches a market, or writes paper decisions', async () => {
  const run = setup();
  const report = await run.service.getReport();
  expect(report.startedAt).toBeNull();
  expect(report.summary.decisionCount).toBe(0);
  expect(report.collector.status).toBe('not-started');
  expect(run.repository.ensurePolicy).not.toHaveBeenCalled();
  expect(run.loadBook).not.toHaveBeenCalled();
  expect(run.loadMarket).not.toHaveBeenCalled();
});

test('persists intent before a delayed book and settles once against the official result', async () => {
  const run = setup();
  await run.service.advance({ market: contract, getForecast: run.getForecast });
  expect(run.state.decisions[0].status).toBe('intent');
  expect(run.state.events).toHaveLength(0);
  expect(run.loadBook).toHaveBeenCalledTimes(1);
  run.advanceTime(PAPER_TRADING_POLICY.minimumFillDelayMs);
  await run.service.advance({ market: contract, getForecast: run.getForecast });
  expect(run.state.events[0].kind).toBe('fill');
  expect(run.state.events[0].book.requestedAt).toBe(checkpoint + 2000);
  expect(run.getForecast).toHaveBeenCalledTimes(1);
  run.advanceTime(400_000);
  await run.service.advance({ market: null, getForecast: run.getForecast });
  await run.service.advance({ market: null, getForecast: run.getForecast });
  expect(run.state.events.map((row) => row.kind)).toEqual(['fill', 'settlement']);
  expect(run.loadMarket).toHaveBeenCalledTimes(1);
  const report = await run.service.getReport();
  expect(report.summary.realizedPnl).toBeGreaterThan(0);
  expect(report.summary.openRisk).toBe(0);
});

test('restart after the fill window records no-fill without reconstructing a past book', async () => {
  const run = setup();
  await run.service.advance({ market: contract, getForecast: run.getForecast });
  run.advanceTime(PAPER_TRADING_POLICY.maximumFillDelayMs + 1);
  const restarted = createPaperTradingService(run.options);
  await restarted.advance({ market: contract, getForecast: run.getForecast });
  expect(run.state.decisions).toHaveLength(1);
  expect(run.state.events[0].kind).toBe('no-fill');
  expect(run.loadBook).toHaveBeenCalledTimes(1);
  expect((await restarted.getReport()).summary.reservedCapital).toBe(0);
});

test('a missed checkpoint is saved as a skip without retrospective forecast or depth reads', async () => {
  const run = setup();
  run.advanceTime(6000);
  await run.service.advance({ market: contract, getForecast: run.getForecast });
  expect(run.state.decisions[0].status).toBe('skipped');
  expect(run.getForecast).not.toHaveBeenCalled();
  expect(run.loadBook).not.toHaveBeenCalled();
});

test('restart during an unfinished execution request cannot request a second, more favorable price', async () => {
  const run = setup();
  await run.service.advance({ market: contract, getForecast: run.getForecast });
  run.advanceTime(2500);
  await run.repository.claimExecutionAttempt({
    decisionId: run.state.decisions[0].id,
    requestedAt: checkpoint + 2500,
  });
  const restarted = createPaperTradingService(run.options);
  await restarted.advance({ market: contract, getForecast: run.getForecast });
  expect(run.state.events[0].kind).toBe('no-fill');
  expect(run.loadBook).toHaveBeenCalledTimes(1);
});

test('a failed decision write retries the identical snapshot before simulating execution', async () => {
  const run = setup();
  run.repository.saveDecision.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(
    run.service.advance({ market: contract, getForecast: run.getForecast }),
  ).rejects.toThrow('storage unavailable');
  const original = run.repository.saveDecision.mock.calls[0][0];
  run.advanceTime(2500);
  await run.service.advance({ market: contract, getForecast: run.getForecast });
  expect(run.repository.saveDecision.mock.calls[1][0]).toEqual(original);
  expect(run.getForecast).toHaveBeenCalledTimes(1);
  expect(run.state.events[0].kind).toBe('fill');
});

test('unavailable depth becomes a saved skip, and an unavailable later book becomes no-fill', async () => {
  const first = setup();
  first.loadBook.mockRejectedValueOnce(new Error('upstream unavailable'));
  await first.service.advance({ market: contract, getForecast: first.getForecast });
  expect(first.state.decisions[0].status).toBe('skipped');
  const second = setup();
  await second.service.advance({ market: contract, getForecast: second.getForecast });
  second.advanceTime(2500);
  second.loadBook.mockRejectedValueOnce(new Error('upstream unavailable'));
  await second.service.advance({ market: contract, getForecast: second.getForecast });
  expect(second.state.events[0].kind).toBe('no-fill');
});

test('settlement outages keep capital reserved and retry no more than once a minute', async () => {
  const run = setup();
  await run.service.advance({ market: contract, getForecast: run.getForecast });
  run.advanceTime(2500);
  await run.service.advance({ market: contract, getForecast: run.getForecast });
  run.advanceTime(400_000);
  run.loadMarket.mockRejectedValueOnce(new Error('outcome pending'));
  await run.service.advance({ market: null, getForecast: run.getForecast });
  run.advanceTime(59_999);
  await run.service.advance({ market: null, getForecast: run.getForecast });
  expect(run.loadMarket).toHaveBeenCalledTimes(1);
  expect((await run.service.getReport()).summary.openRisk).toBeGreaterThan(0);
  run.advanceTime(1);
  await run.service.advance({ market: null, getForecast: run.getForecast });
  expect(run.state.events.at(-1).kind).toBe('settlement');
});

test('concurrent ticks share one operation and create only one entry opportunity', async () => {
  const run = setup();
  await Promise.all([
    run.service.advance({ market: contract, getForecast: run.getForecast }),
    run.service.advance({ market: contract, getForecast: run.getForecast }),
  ]);
  expect(run.state.decisions).toHaveLength(1);
  expect(run.getForecast).toHaveBeenCalledTimes(1);
  await run.service.stop();
  expect((await run.repository.readHeartbeat()).status).toBe('stopped');
});

test('the complete workflow survives a restart using durable compact reads and execution claims', async () => {
  const run = setup();
  const client = createClient({ url: 'file::memory:' });
  try {
    const repository = createPaperTradingRepository({ client, now: run.options.now });
    const service = createPaperTradingService({ ...run.options, repository });
    await service.advance({ market: contract, getForecast: run.getForecast });
    run.advanceTime(2500);
    const restarted = createPaperTradingService({ ...run.options, repository });
    await restarted.advance({ market: contract, getForecast: run.getForecast });
    const filled = await repository.readState(PAPER_TRADING_POLICY.id, { includeAttempts: true });
    expect(filled.events[0].kind).toBe('fill');
    expect(filled.attempts).toHaveLength(1);
    run.advanceTime(400_000);
    await restarted.advance({ market: null, getForecast: run.getForecast });
    const report = await restarted.getReport();
    expect(report.summary.settledCount).toBe(1);
    expect(report.summary.cash).toBeCloseTo(100 + report.summary.actualNetPnl, 6);
    expect(report.summary.reservedCapital).toBe(0);
    expect(report.summary.openRisk).toBe(0);
  } finally {
    client.close();
  }
});
