import {
  createPaperDecision,
  getPaperPortfolio,
  getPaperTradingReport,
  isPaperDecision,
  isPaperExecutionEvent,
  settlePaperPosition,
  simulatePaperFill,
} from '../../utils/paperTrading.utils';
import {
  createMarketMetadata,
  createSpecifiedMarket,
} from '../../../TradingAdvisor/__tests__/helpers/marketRulesFixtures';
import legacy from './helpers/legacyPaperAccount.json';

// This fixture was generated with the source at its recorded Git commit, before
// Phase 2. It contains synthetic observations, not a historical performance claim.
test('an existing paper account remains readable and settles with its original money and evidence', () => {
  const before = JSON.stringify(legacy);
  expect(isPaperDecision(legacy.decision)).toBe(true);
  expect(isPaperExecutionEvent(legacy.execution, legacy.decision)).toBe(true);
  expect(
    settlePaperPosition({
      decision: legacy.decision,
      fill: legacy.execution,
      market: legacy.settlement.market,
      now: legacy.readAt,
    }),
  ).toEqual(legacy.settlement);
  const saved = {
    decisions: [legacy.decision],
    events: [legacy.execution, legacy.settlement],
    now: legacy.readAt,
  };
  expect(getPaperPortfolio(saved)).toEqual(legacy.portfolio);
  expect(getPaperTradingReport(saved)).toMatchObject(legacy.portfolio);
  expect(JSON.stringify(legacy)).toBe(before);
});

test('missing rules skip new opportunities and cancel a legacy pending intent without changing its record', () => {
  const { contract, forecast, book, portfolio, decidedAt: now } = legacy.decision;
  const skipped = createPaperDecision({ contract, forecast, book, portfolio, now });
  expect(skipped).toMatchObject({
    version: 'paper-decision-v2',
    status: 'skipped',
    reason: 'market_specification_unverified',
    reservedCapital: 0,
  });
  expect(isPaperDecision(skipped)).toBe(true);
  const canceled = simulatePaperFill({
    decision: legacy.decision,
    book: legacy.execution.book,
    now: legacy.execution.recordedAt,
  });
  expect(canceled).toMatchObject({
    version: 'paper-execution-v2',
    kind: 'no-fill',
    reason: 'market_specification_unverified',
    quantity: 0,
  });
  expect(isPaperExecutionEvent(canceled, legacy.decision)).toBe(true);
  expect(
    getPaperPortfolio({
      decisions: [legacy.decision],
      events: [canceled],
      now: legacy.execution.recordedAt,
    }),
  ).toMatchObject({ cash: 100, openRisk: 0, reservedCapital: 0, openPositionCount: 0 });
  expect(legacy.decision.status).toBe('intent');
});

test('new paper decisions and delayed fills use the verified grid while preserving exact cost conservation', () => {
  const { forecast, portfolio, decidedAt: now } = legacy.decision;
  const contract = createSpecifiedMarket({
    raw: createMarketMetadata({
      startsAt: legacy.decision.contract.startsAt,
      ticker: legacy.decision.contract.ticker,
      event_ticker: legacy.decision.contract.eventTicker,
      floor_strike: legacy.decision.contract.target,
      price_ranges: [{ start: '0.0000', end: '1.0000', step: '0.0250' }],
    }),
    now,
  });
  const book = {
    ...legacy.decision.book,
    yesAsks: [{ price: 0.4, quantity: 10 }],
    noAsks: [{ price: 0.65, quantity: 10 }],
  };
  const decision = createPaperDecision({ contract, forecast, book, portfolio, now });
  expect(decision).toMatchObject({
    version: 'paper-decision-v2',
    status: 'intent',
    limitPrice: 0.8,
  });
  expect(isPaperDecision(decision)).toBe(true);
  const later = now + 3000;
  const execution = simulatePaperFill({
    decision,
    book: { ...book, requestedAt: later, receivedAt: later },
    now: later,
  });
  expect(execution).toMatchObject({
    version: 'paper-execution-v2',
    kind: 'fill',
    quantity: 1,
    cost: 0.425,
    fee: 0.0172,
    totalCost: 0.4422,
    fills: [{ price: 0.425, quantity: 1 }],
  });
  expect(isPaperExecutionEvent(execution, decision)).toBe(true);
  expect(
    getPaperPortfolio({ decisions: [decision], events: [execution], now: later }),
  ).toMatchObject({
    cash: 99.5578,
    openRisk: 0.4422,
    reservedCapital: 0,
    openPositionCount: 1,
  });
});
