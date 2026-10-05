/** @jest-environment node */
import {
  createAdvisorResearchPolicy,
  createTradingAdvisorPolicy,
} from '../utils/advisorPolicy.utils';
import { getAdvisorReason } from '../utils/advisorDisplay.utils';
import { getAdvisorValuation } from '../utils/advisorValuation.utils';
import {
  getTradingAdvice,
  getTradingExecutionQuote,
  simulateTradingExecution,
} from '../utils/tradingAdvisor.utils';
import {
  createAdvisorAccount,
  getAdvisorPortfolio,
} from '@/services/research/tradingAdvisor/tradingAdvisor.ledger';
import { START, contract, bookAt, forecastAt } from './TradingAdvisor.fixtures';

const NOW = START + 300000;
const policy = createTradingAdvisorPolicy({
  riskLevel: 'balanced',
  runId: 'entry-restrictions',
  dailyLossLimitEnabled: false,
});
const input = ({
  cash = 100,
  probability = 0.85,
  book = bookAt(NOW),
  activePolicy = policy,
} = {}) => {
  const portfolio = {
    ...getAdvisorPortfolio(createAdvisorAccount(activePolicy), NOW),
    cash,
    realizedPnl: cash - activePolicy.initialBankroll,
    riskHistory: { peakEquity: activePolicy.initialBankroll },
  };
  return {
    contract,
    forecast: forecastAt(NOW, probability),
    book,
    portfolio: {
      ...portfolio,
      valuation: getAdvisorValuation({ portfolio, books: [book], now: NOW, policy: activePolicy }),
    },
    now: NOW,
    policy: activePolicy,
  };
};

test('identifies $0.079 of remaining loss capacity without modifying the $85 account floor', () => {
  const value = input({ cash: 85.079 });
  const original = JSON.stringify(value.portfolio);
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'wait',
    reason: 'insufficient_loss_capacity',
  });
  expect(JSON.stringify(value.portfolio)).toBe(original);
  expect(policy.initialBankroll - policy.maxDrawdown).toBe(85);
});

test('identifies capacity when the affordable opposite side has no edge', () => {
  const book = {
    ...bookAt(NOW),
    yesAsks: [{ price: 0.7, quantity: 20 }],
    noAsks: [{ price: 0.32, quantity: 20 }],
  };
  expect(getTradingAdvice(input({ cash: 85.5, probability: 0.99, book }))).toMatchObject({
    action: 'wait',
    reason: 'insufficient_loss_capacity',
  });
});

test('identifies capacity when the displayed fractional price fits but the whole-cent limit does not', () => {
  const book = {
    ...bookAt(NOW),
    yesAsks: [{ price: 0.062, quantity: 1 }],
    noAsks: [{ price: 0.95, quantity: 1 }],
  };
  expect(getTradingAdvice(input({ cash: 85.079, book }))).toMatchObject({
    action: 'wait',
    reason: 'insufficient_loss_capacity',
  });
});

test('reports insufficient edge when displayed contracts are affordable but neither side qualifies', () => {
  expect(getTradingAdvice(input({ probability: 0.5 }))).toMatchObject({
    action: 'wait',
    reason: 'insufficient_entry_edge',
  });
});

test.each([
  { yesAsks: [], noAsks: [] },
  {
    yesAsks: [{ price: 0.5, quantity: 0.5 }],
    noAsks: [{ price: 0.55, quantity: 0.5 }],
  },
])('reports missing depth when neither side can fill one contract: %j', (depth) => {
  expect(getTradingAdvice(input({ book: { ...bookAt(NOW), ...depth } }))).toMatchObject({
    action: 'wait',
    reason: 'missing_entry_depth',
  });
});

test('keeps loss capacity distinct when the delayed book has depth for only one unaffordable contract', () => {
  const advice = getTradingAdvice(input());
  const time = NOW + policy.minimumFillDelayMs;
  const book = { ...bookAt(time), yesAsks: [{ price: 0.5, quantity: 1 }] };
  const value = input({ cash: 85.079 });
  expect(
    simulateTradingExecution({ advice, book, portfolio: value.portfolio, now: time }),
  ).toMatchObject({ kind: 'no-fill', reason: 'insufficient_loss_capacity' });
});

test('reports expired execution independently of current capacity and depth', () => {
  const advice = getTradingAdvice(input());
  const time = NOW + policy.maximumFillDelayMs + 1;
  expect(
    simulateTradingExecution({
      advice,
      book: null,
      portfolio: input({ cash: 85.079 }).portfolio,
      now: time,
    }),
  ).toMatchObject({ kind: 'no-fill', reason: 'execution_window_expired' });
});

test('caps new entries at one contract while keeping larger existing positions sellable', () => {
  const smallPolicy = createAdvisorResearchPolicy(policy);
  const value = input({ activePolicy: smallPolicy });
  const buy = getTradingAdvice(value);
  expect(buy).toMatchObject({ action: 'buy', quantity: 1 });
  expect(
    getTradingExecutionQuote({ ...value, action: 'buy', side: 'yes', quantity: 2 }),
  ).toMatchObject({ available: false, reason: 'invalid_execution_request' });
  expect(
    simulateTradingExecution({
      advice: { ...buy, quantity: 2 },
      portfolio: value.portfolio,
      book: bookAt(NOW + smallPolicy.minimumFillDelayMs),
      now: NOW + smallPolicy.minimumFillDelayMs,
    }),
  ).toMatchObject({ kind: 'no-fill', reason: 'invalid_execution_request' });
  const position = {
    id: 'existing-position',
    contract,
    side: 'yes',
    quantity: 5,
    costBasis: 2.5,
  };
  const sale = getTradingAdvice({
    ...value,
    forecast: forecastAt(NOW, 0.05),
    portfolio: {
      ...value.portfolio,
      cash: 85.079,
      openRisk: 2.5,
      valuation: null,
      positions: [position],
    },
  });
  expect(sale).toMatchObject({ action: 'sell', quantity: 5 });
  expect(
    simulateTradingExecution({
      advice: sale,
      portfolio: { ...value.portfolio, positions: [position] },
      book: bookAt(NOW + smallPolicy.minimumFillDelayMs),
      now: NOW + smallPolicy.minimumFillDelayMs,
    }),
  ).toMatchObject({ kind: 'fill', action: 'sell', quantity: 5 });
});

test.each([
  ['insufficient_loss_capacity', 'Insufficient loss capacity:'],
  ['insufficient_entry_edge', 'Insufficient edge:'],
  ['missing_entry_depth', 'Missing depth:'],
  ['execution_window_expired', 'Expired execution:'],
])('explains the specific recorded restriction %s', (reason, label) => {
  expect(getAdvisorReason(reason)).toMatch(label);
});

test('does not invent a precise reason for older generic assessments', () => {
  expect(getAdvisorReason('insufficient_entry_edge_or_depth')).toBe(
    'This older assessment did not record which entry restriction applied.',
  );
});
