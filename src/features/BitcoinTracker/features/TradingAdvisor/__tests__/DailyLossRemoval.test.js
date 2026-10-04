/** @jest-environment node */
import {
  createTradingAdvisorPolicy,
  getAdvisorEntryRisk,
  isAdvisorV2Policy,
} from '../utils/advisorPolicy.utils';
import {
  TRADING_ADVISOR_POLICY,
  getTradingAdvice,
  isTradingAdvisorPolicy,
  simulateTradingExecution,
} from '../utils/tradingAdvisor.utils';
import { getAdvisorValuation } from '../utils/advisorValuation.utils';
import {
  createAdvisorAccount,
  getAdvisorPortfolio,
} from '@/services/research/tradingAdvisor/tradingAdvisor.ledger';
import { START, contract, bookAt, forecastAt } from './TradingAdvisor.fixtures';

const NOW = START + 300000;
const day = new Date(NOW).toISOString().slice(0, 10);
const prospectiveLegacy = {
  ...TRADING_ADVISOR_POLICY,
  id: 'kalshi-advisor-v3-12345678-1234-1234-1234-123456789abc',
  dailyLossLimitEnabled: false,
};
const policy = createTradingAdvisorPolicy({ runId: 'daily-limit-removed' });

function input(selectedPolicy = policy, dailyLoss = 6) {
  const account = {
    ...createAdvisorAccount(selectedPolicy),
    cash: selectedPolicy.initialBankroll - dailyLoss,
    realizedPnl: -dailyLoss,
    dailyRealizedPnl: -dailyLoss,
    realizedDay: day,
    equityDay: day,
    dailyStartEquity: selectedPolicy.initialBankroll,
  };
  const portfolio = getAdvisorPortfolio(account, NOW);
  return {
    contract,
    book: bookAt(NOW),
    forecast: forecastAt(NOW),
    now: NOW,
    policy: selectedPolicy,
    portfolio: {
      ...portfolio,
      valuation: getAdvisorValuation({
        portfolio,
        books: [bookAt(NOW)],
        now: NOW,
        policy: selectedPolicy,
      }),
      riskHistory: { peakEquity: selectedPolicy.initialBankroll },
    },
  };
}

test('new v2 policies explicitly disable daily loss gating without changing the legacy policy', () => {
  expect(policy.dailyLossLimitEnabled).toBe(false);
  expect(isAdvisorV2Policy(policy)).toBe(true);
  expect(Object.hasOwn(TRADING_ADVISOR_POLICY, 'dailyLossLimitEnabled')).toBe(false);
  expect(isTradingAdvisorPolicy(prospectiveLegacy)).toBe(true);
});

test.each([prospectiveLegacy, policy])(
  'a new %p policy can recommend and fill a buy after more than $5 daily losses',
  (selectedPolicy) => {
    const value = input(selectedPolicy);
    const advice = getTradingAdvice(value);
    expect(advice.action).toBe('buy');
    expect(advice.policy.dailyLossLimitEnabled).toBe(false);
    const execution = simulateTradingExecution({
      advice,
      portfolio: value.portfolio,
      book: bookAt(NOW + 2000),
      now: NOW + 2000,
    });
    expect(execution.kind).toBe('fill');
    expect(execution.totalCost).toBeLessThanOrEqual(selectedPolicy.maxPositionCost);
    expect(value.portfolio.dailyRealizedPnl).toBe(-6);
  },
);

test('daily equity loss and committed risk no longer recreate the removed cutoff', () => {
  const value = input(policy, 0);
  const risk = getAdvisorEntryRisk({
    policy,
    now: NOW,
    portfolio: {
      ...value.portfolio,
      dailyStartEquity: 120,
      dailyRealizedPnl: -20,
      cash: 94,
      openRisk: 6,
      valuation: { ...value.portfolio.valuation, executableEquity: 99, liquidationValue: 5 },
    },
  });
  // Cash, exposure and total drawdown still constrain this to $4, even though the
  // old daily realized/equity loss and remaining daily risk checks all would fail.
  expect(risk).toMatchObject({ reason: null, budget: 4, equity: 99 });
});

test.each([
  [{ riskHistory: { peakEquity: 111 } }, 'equity_drawdown_limit'],
  [{ cash: 60 }, 'portfolio_loss_capacity_exhausted'],
  [{ openRisk: 15 }, 'portfolio_loss_capacity_exhausted'],
  [{ valuation: null }, 'risk_valuation_unavailable_or_stale'],
  [{ lastLossAt: NOW - 1000 }, 'loss_cooldown'],
])('retains other portfolio protections when daily loss gating is disabled', (patch, reason) => {
  const value = input(policy, 0);
  expect(getTradingAdvice({ ...value, portfolio: { ...value.portfolio, ...patch } })).toMatchObject(
    { action: 'wait', reason },
  );
});

test('old policies with no flag retain their original daily cutoff for advice and execution replay', () => {
  const { dailyLossLimitEnabled, ...archivedV2 } = createTradingAdvisorPolicy({
    runId: 'archive',
    dailyLossLimitEnabled: true,
  });
  expect(isAdvisorV2Policy(archivedV2)).toBe(true);
  for (const archived of [TRADING_ADVISOR_POLICY, archivedV2]) {
    const value = input(archived);
    expect(getTradingAdvice(value)).toMatchObject({ action: 'wait', reason: 'daily_loss_limit' });
    const advice = getTradingAdvice(input(archived, 0));
    expect(advice.action).toBe('buy');
    expect(
      simulateTradingExecution({
        advice,
        portfolio: value.portfolio,
        book: bookAt(NOW + 2000),
        now: NOW + 2000,
      }),
    ).toMatchObject({ kind: 'no-fill', reason: 'daily_loss_limit' });
  }
});

test('explicit historical enabled policies retain equity and risk-budget daily controls', () => {
  const historical = createTradingAdvisorPolicy({ runId: 'enabled', dailyLossLimitEnabled: true });
  const value = input(historical, 0);
  expect(
    getAdvisorEntryRisk({
      policy: historical,
      now: NOW,
      portfolio: { ...value.portfolio, dailyStartEquity: 106 },
    }).reason,
  ).toBe('daily_equity_loss_limit');
  expect(
    getAdvisorEntryRisk({
      policy: historical,
      now: NOW,
      portfolio: { ...value.portfolio, openRisk: 5 },
    }).reason,
  ).toBe('portfolio_loss_capacity_exhausted');
});

test.each([null, 0, 'false'])('rejects malformed daily-loss flag values: %p', (flag) => {
  expect(isTradingAdvisorPolicy({ ...prospectiveLegacy, dailyLossLimitEnabled: flag })).toBe(false);
  expect(isAdvisorV2Policy({ ...policy, dailyLossLimitEnabled: flag })).toBe(false);
  expect(() => createTradingAdvisorPolicy({ dailyLossLimitEnabled: flag })).toThrow();
});
