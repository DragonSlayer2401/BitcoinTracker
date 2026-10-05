/** @jest-environment node */
import {
  getAdvisorCandidateEvidence,
  getHistoryRulesDecision,
  isAdvisorCandidateOutputShape,
  simulateAdvisorCandidateExecution,
  validateAdvisorCandidateDecision,
} from '../utils/advisorCandidate.utils';
import { createTradingAdvisorPolicy } from '../utils/advisorPolicy.utils';
import {
  getTradingAdvice,
  getTradingQuoteAmounts,
  simulateTradingExecution,
} from '../utils/tradingAdvisor.utils';
import { getAdvisorValuation } from '../utils/advisorValuation.utils';
import {
  applyAdvisorAdvice,
  applyAdvisorEvent,
  createAdvisorAccount,
  getAdvisorPortfolio,
} from '@/services/research/tradingAdvisor/tradingAdvisor.ledger';
import { START, contract, bookAt, forecastAt } from './TradingAdvisor.fixtures';

const NOW = START + 300000;
const policy = createTradingAdvisorPolicy({ runId: 'candidate-test' });
const portfolioAt = (account, at, book) => {
  const portfolio = getAdvisorPortfolio(account, at);
  return {
    ...portfolio,
    valuation: getAdvisorValuation({ portfolio, books: [book], now: at, policy }),
    riskHistory: { peakEquity: 100 },
  };
};
function input({
  probability = 0.85,
  now = NOW,
  position = false,
  book = bookAt(now),
  history = [],
} = {}) {
  const account = createAdvisorAccount(policy);
  if (position) {
    account.cash = 95;
    account.positions = [
      {
        id: 'position',
        contract,
        side: 'yes',
        quantity: 10,
        costBasis: 5,
        entryFees: 0.1,
        averagePrice: 0.49,
        openedAt: now - 5000,
        entryAdviceId: 'original-entry',
        entryRationale: 'An entry advantage survived costs.',
        entryProbability: 0.7,
      },
    ];
    account.pendingComparisons = [
      {
        positionId: 'position',
        entryAdviceId: 'original-entry',
        contract,
        side: 'yes',
        initialQuantity: 10,
        initialCost: 5,
        initialEntryFee: 0.1,
        actualProceeds: 0,
      },
    ];
  }
  return {
    snapshotId: `snapshot-${now}`,
    contract,
    forecast: {
      ...forecastAt(now, probability),
      referencePrice: contract.target + 25,
      referenceAt: now,
      minuteVolatility: 0.001,
      volatility: 0.003,
    },
    book,
    portfolio: portfolioAt(account, now, book),
    now,
    policy,
    history,
    account,
  };
}
const history = (probabilities, now = NOW, book = bookAt(now)) =>
  probabilities.map((probability, index) => {
    const observedAt = now - (probabilities.length - index) * 15000;
    return {
      snapshotId: `past-${observedAt}`,
      contract,
      forecast: forecastAt(observedAt, probability),
      book: {
        ...book,
        requestedAt: observedAt,
        receivedAt: observedAt,
        fee: { ...book.fee, checkedAt: observedAt, validUntil: observedAt + 30000 },
      },
      observedAt,
    };
  });
function selection(evidence, action) {
  const option = evidence.options.find((item) => item.action === action);
  return {
    action,
    optionId: option?.id ?? 'unavailable-option',
    snapshotId: evidence.snapshotId,
    evidenceRefs: [evidence.points.at(-1).id, evidence.account.id],
    rationale: 'Fresh evidence supports this selected plan after the supplied costs.',
    thesis: 'Hold only while the evidence supports the original opportunity.',
    invalidationConditions: ['The probability or executable value materially deteriorates.'],
    reviewHorizon: '15s',
  };
}
const validate = (value, decision, extra = {}) => {
  const evidence = getAdvisorCandidateEvidence(value);
  return validateAdvisorCandidateDecision({
    decision: decision ?? getHistoryRulesDecision(evidence),
    evidence,
    currentInput: value,
    candidatePolicyVersion: 'history-llm-v1',
    receivedAt: value.now,
    now: value.now,
    ...extra,
  });
};

test('provides bounded causal same-contract history and code-calculated market, position and account evidence', () => {
  const value = input({ position: true });
  const past = history(Array.from({ length: 30 }, () => 0.7));
  value.history = [
    ...past,
    { ...past.at(-1), snapshotId: 'changed-target', contract: { ...contract, target: 76000 } },
    { ...past.at(-1), snapshotId: 'future', observedAt: NOW + 1 },
    { ...past.at(-1), snapshotId: 'stale', forecast: forecastAt(NOW - 60000) },
  ];
  const evidence = getAdvisorCandidateEvidence(value);
  expect(evidence.available).toBe(true);
  expect(evidence.points).toHaveLength(12);
  expect(
    evidence.points.every((point) => point.observedAt <= NOW && NOW - point.observedAt <= 180000),
  ).toBe(true);
  expect(evidence.evidenceIds).not.toContain('changed-target:market');
  expect(evidence.evidenceIds).not.toContain('future:market');
  expect(evidence.points.at(-1)).toMatchObject({
    referencePrice: 75025,
    targetDistance: 25,
    minuteVolatility: 0.001,
    horizonVolatility: 0.003,
    yesAskDepth: 100,
  });
  expect(evidence.position).toMatchObject({
    ageMs: 5000,
    entryProbability: 0.7,
    entryRationale: 'An entry advantage survived costs.',
  });
  expect(
    evidence.options.find((option) => option.action === 'EXIT').advice.expectedProceeds,
  ).toBeGreaterThan(0);
  expect(Object.isFrozen(evidence)).toBe(true);
});

test('history rules wait for persistent entry value, without weakening the incumbent numerical entry requirements', () => {
  const brief = input();
  expect(getHistoryRulesDecision(getAdvisorCandidateEvidence(brief)).action).toBe('NO_TRADE');
  const persistent = input({ probability: 0.83, history: history([0.85, 0.84]) });
  const evidence = getAdvisorCandidateEvidence(persistent);
  expect(getHistoryRulesDecision(evidence).action).toBe('BUY_YES');
  expect(evidence.options.find((option) => option.action === 'BUY_YES').advice).toEqual(
    getTradingAdvice(persistent),
  );
  const noEdge = input({ probability: 0.5, history: history([0.5, 0.5]) });
  expect(getHistoryRulesDecision(getAdvisorCandidateEvidence(noEdge)).action).toBe('NO_TRADE');
});

test('a brief pullback keeps HOLD while sustained deterioration permits EXIT', () => {
  const pullback = input({ position: true, probability: 0.64, history: history([0.65, 0.63]) });
  expect(getHistoryRulesDecision(getAdvisorCandidateEvidence(pullback)).action).toBe('HOLD');
  const deterioration = input({ position: true, probability: 0.44, history: history([0.7, 0.6]) });
  expect(getHistoryRulesDecision(getAdvisorCandidateEvidence(deterioration)).action).toBe('EXIT');
});

test('severe new evidence and approaching expiry may exit immediately without a minimum hold', () => {
  const shock = input({ position: true, probability: 0.43, history: history([0.7]) });
  expect(getHistoryRulesDecision(getAdvisorCandidateEvidence(shock)).action).toBe('EXIT');
  const nearExpiry = input({ position: true, probability: 0.44, now: contract.expiresAt - 40000 });
  expect(getHistoryRulesDecision(getAdvisorCandidateEvidence(nearExpiry)).action).toBe('EXIT');
});

test('moderate persistent deterioration can reduce the position rather than force a full exit', () => {
  const book = {
    ...bookAt(NOW),
    yesAsks: [{ price: 0.52, quantity: 100 }],
    noAsks: [{ price: 0.5, quantity: 100 }],
  };
  const value = input({
    position: true,
    probability: 0.51,
    book,
    history: history([0.58, 0.54], NOW, book),
  });
  const evidence = getAdvisorCandidateEvidence(value);
  const decision = getHistoryRulesDecision(evidence);
  expect(decision.action).toBe('REDUCE');
  expect(evidence.options.find((option) => option.id === decision.optionId).advice.quantity).toBe(
    5,
  );
});

test.each([
  ['yes', 0.1, 0.46],
  ['no', 0.9, 0.51],
])(
  'AI HOLD for %s keeps its advance target above the raw bid when numerical advice sells',
  (side, probability, expectedLimit) => {
    const value = input({ position: true, probability });
    value.portfolio.positions[0].side = side;
    expect(getTradingAdvice(value).action).toBe('sell');
    const evidence = getAdvisorCandidateEvidence(value);
    const accepted = validate(value, selection(evidence, 'HOLD'));
    expect(accepted).toMatchObject({
      accepted: true,
      advice: { action: 'hold', candidatePolicyVersion: 'history-llm-v1' },
      plan: { action: 'HOLD', status: 'active' },
    });
    expect(accepted.advice.policy).toEqual(policy);
    const target = accepted.advice.exitPlan;
    const rawBestBid = 1 - value.book[side === 'yes' ? 'noAsks' : 'yesAsks'][0].price;
    expect(target.limitPrice).toBeGreaterThan(rawBestBid);
    expect(target.limitPrice).toBe(expectedLimit);
    const targetAmounts = getTradingQuoteAmounts(
      [{ price: target.limitPrice, quantity: target.quantity }],
      'sell',
      value.book.fee,
      NOW,
    );
    expect(target.netProceeds).toBe(targetAmounts.netProceeds);
    expect(target.estimatedProfit).toBeCloseTo(target.netProceeds - target.costBasis, 6);
  },
);

test('HOLD does not suggest a marketable sell target when the best bid is already 99 cents', () => {
  const value = input({
    position: true,
    probability: 0.5,
    book: {
      ...bookAt(NOW),
      yesAsks: [{ price: 0.99, quantity: 100 }],
      noAsks: [{ price: 0.01, quantity: 100 }],
    },
  });
  expect(getTradingAdvice(value).action).toBe('sell');
  const evidence = getAdvisorCandidateEvidence(value);
  const accepted = validate(value, selection(evidence, 'HOLD'));
  expect(accepted).toMatchObject({
    accepted: true,
    advice: {
      action: 'hold',
      exitPlan: {
        available: false,
        limitPrice: null,
        reason: 'no_higher_resting_sell_limit',
      },
    },
  });
});

test('HOLD keeps the fee-adjusted holding target when there are no current buyers', () => {
  const value = input({
    position: true,
    probability: 0.6,
    book: { ...bookAt(NOW), noAsks: [] },
  });
  const numerical = getTradingAdvice(value);
  expect(numerical).toMatchObject({ action: 'wait', reason: 'insufficient_exit_depth' });
  const evidence = getAdvisorCandidateEvidence(value);
  const accepted = validate(value, selection(evidence, 'HOLD'));
  expect(accepted.accepted).toBe(true);
  expect(accepted.advice.exitPlan).toEqual(numerical.exitPlan);
});

test('HOLD prices its available position rather than inheriting the numerical partial-sale quantity', () => {
  const value = input({
    position: true,
    probability: 0.1,
    book: { ...bookAt(NOW), noAsks: [{ price: 0.55, quantity: 3 }] },
  });
  expect(getTradingAdvice(value)).toMatchObject({
    action: 'sell',
    quantity: 3,
    exitPlan: { quantity: 3, costBasis: 1.5 },
  });
  const evidence = getAdvisorCandidateEvidence(value);
  const accepted = validate(value, selection(evidence, 'HOLD'));
  expect(accepted).toMatchObject({
    accepted: true,
    advice: {
      action: 'hold',
      quantity: 10,
      exitPlan: { available: true, side: 'yes', quantity: 10, costBasis: 5 },
    },
  });
});

test.each([4, 0])(
  'HOLD only offers a sell target for the %s contracts not reserved by a pending order',
  (availableQuantity) => {
    const value = input({ position: true, probability: 0.6 });
    value.portfolio.positions[0].availableQuantity = availableQuantity;
    value.portfolio.pendingIntents = [{ id: 'pending-sale', contract }];
    expect(getTradingAdvice(value)).toMatchObject({
      action: 'wait',
      reason: 'pending_execution',
      exitPlan: null,
    });
    const evidence = getAdvisorCandidateEvidence(value);
    const hold = evidence.options.find((option) => option.action === 'HOLD').advice;
    expect(hold.quantity).toBe(10);
    if (availableQuantity) {
      expect(hold.exitPlan).toMatchObject({
        available: true,
        quantity: availableQuantity,
        costBasis: 2,
      });
    } else expect(hold.exitPlan).toBeNull();
    expect(evidence.options.map((option) => option.action)).toEqual(['HOLD']);
  },
);

test('AI can realize an early scalp after entry and exit fees while the numerical baseline holds', () => {
  const entryInput = input();
  const entryAdvice = { ...getTradingAdvice(entryInput), id: 'scalp-entry' };
  expect(entryAdvice.action).toBe('buy');
  expect(entryAdvice.maxCost).toBeLessThanOrEqual(policy.maxPositionCost);
  const entryAccount = applyAdvisorAdvice(entryInput.account, entryAdvice);
  const entryAt = NOW + policy.minimumFillDelayMs;
  const entryBook = bookAt(entryAt);
  const releasedPortfolio = getAdvisorPortfolio(entryAccount, entryAt, entryAdvice.id);
  const entry = {
    ...simulateTradingExecution({
      advice: entryAdvice,
      book: entryBook,
      portfolio: {
        ...releasedPortfolio,
        valuation: getAdvisorValuation({
          portfolio: releasedPortfolio,
          books: [entryBook],
          now: entryAt,
          policy,
        }),
        riskHistory: { peakEquity: 100 },
      },
      now: entryAt,
    }),
    adviceId: entryAdvice.id,
  };
  expect(entry.kind).toBe('fill');
  expect(entry.fee).toBeGreaterThan(0);
  const heldAccount = applyAdvisorEvent(entryAccount, entry).account;
  const reviewAt = entryAt + 3000;
  const saleBookAt = (at) => ({
    ...bookAt(at),
    yesAsks: [{ price: 0.7, quantity: 100 }],
    noAsks: [{ price: 0.35, quantity: 100 }],
  });
  const value = {
    ...input({ now: reviewAt, probability: 0.75, book: saleBookAt(reviewAt) }),
    account: heldAccount,
    portfolio: portfolioAt(heldAccount, reviewAt, saleBookAt(reviewAt)),
  };
  expect(getTradingAdvice(value).action).toBe('hold');
  const evidence = getAdvisorCandidateEvidence(value);
  const accepted = validate(value, selection(evidence, 'EXIT'));
  expect(accepted).toMatchObject({
    accepted: true,
    advice: {
      action: 'sell',
      candidatePolicyVersion: 'history-llm-v1',
      candidateExit: { version: 'history-exit-v1' },
    },
  });
  expect(accepted.advice.policy).toEqual(policy);
  const saleAdvice = { ...accepted.advice, id: 'scalp-exit' };
  const reserved = applyAdvisorAdvice(heldAccount, saleAdvice);
  const saleAt = reviewAt + policy.minimumFillDelayMs;
  const sale = {
    ...simulateAdvisorCandidateExecution({
      advice: saleAdvice,
      book: saleBookAt(saleAt),
      portfolio: getAdvisorPortfolio(reserved, saleAt, saleAdvice.id),
      now: saleAt,
    }),
    adviceId: saleAdvice.id,
  };
  expect(sale).toMatchObject({ kind: 'fill', quantity: entry.quantity, fullyCovered: true });
  expect(sale.price).toBeGreaterThanOrEqual(saleAdvice.limitPrice);
  expect(sale.fee).toBeGreaterThan(0);
  const { account, realizedPnl } = applyAdvisorEvent(reserved, sale);
  expect(realizedPnl).toBeGreaterThan(0);
  expect(realizedPnl).toBeCloseTo(sale.proceeds - entry.cost - entry.fee - sale.fee, 6);
  expect(account.cash).toBeCloseTo(policy.initialBankroll + realizedPnl, 6);
  expect(account.positions).toHaveLength(0);
  expect(saleAt).toBeLessThan(contract.expiresAt);
});

test('candidate EXIT can execute under its explicit exit version while the incumbent continues HOLD', () => {
  const value = input({ position: true, probability: 0.5 });
  expect(getTradingAdvice(value).action).toBe('hold');
  const evidence = getAdvisorCandidateEvidence(value);
  const accepted = validate(value, selection(evidence, 'EXIT'));
  expect(accepted.accepted).toBe(true);
  const advice = { ...accepted.advice, id: 'candidate-order' };
  const at = NOW + 2000;
  const book = { ...bookAt(at), noAsks: [{ price: 0.55, quantity: 3 }] };
  const reserved = applyAdvisorAdvice(value.account, advice);
  const portfolio = getAdvisorPortfolio(reserved, at, advice.id);
  const event = simulateAdvisorCandidateExecution({ advice, book, portfolio, now: at });
  expect(event).toMatchObject({
    kind: 'fill',
    quantity: 3,
    requestedQuantity: 10,
    canceledQuantity: 7,
    fullyCovered: false,
  });
  const { account, realizedPnl } = applyAdvisorEvent(reserved, { ...event, adviceId: advice.id });
  expect(account.positions[0]).toMatchObject({ quantity: 7, costBasis: 3.5 });
  expect(realizedPnl).toBeCloseTo(event.netProceeds - 1.5, 7);
  expect(account.pendingIntents).toHaveLength(0);
  expect(() => applyAdvisorEvent(account, { ...event, adviceId: advice.id })).toThrow();
  expect(simulateTradingExecution({ advice, book: bookAt(at), portfolio, now: at }).kind).toBe(
    'no-fill',
  );
});

test('rechecks current prices and keeps every quantity and price out of model output', () => {
  const value = input();
  const evidence = getAdvisorCandidateEvidence(value);
  const decision = selection(evidence, 'BUY_YES');
  const now = NOW + 3000;
  const refreshed = input({
    now,
    book: { ...bookAt(now), yesAsks: [{ price: 0.53, quantity: 100 }] },
  });
  const accepted = validate(value, decision, {
    evidence,
    currentInput: refreshed,
    receivedAt: now,
    now,
  });
  expect(accepted.accepted).toBe(true);
  expect(accepted.advice.evaluatedAt).toBe(now);
  expect(accepted.advice.quotedCost).not.toBe(
    evidence.options.find((option) => option.id === decision.optionId).advice.quotedCost,
  );
  expect(validate(value, { ...decision, quantity: 1000 }).reason).toBe('invalid_candidate_output');
  expect(
    isAdvisorCandidateOutputShape({
      ...decision,
      rationale: 'This is guaranteed with 99% confidence.',
    }),
  ).toBe(false);
});

test.each([
  [
    'false reference',
    (value, evidence, decision) => ({
      decision: { ...decision, evidenceRefs: ['fabricated-price'] },
    }),
    'unknown_evidence_reference',
  ],
  [
    'expired',
    (value) => ({ now: NOW + 30000, receivedAt: NOW + 30000 }),
    'expired_or_noncausal_response',
  ],
  ['future response', () => ({ receivedAt: NOW + 1 }), 'expired_or_noncausal_response'],
  [
    'superseded',
    (value) => ({ currentInput: { ...value, activeSnapshotId: 'newer-snapshot' } }),
    'superseded_snapshot',
  ],
  [
    'account changed',
    (value) => ({
      currentInput: { ...value, portfolio: { ...value.portfolio, accountVersion: 1 } },
    }),
    'account_changed',
  ],
  [
    'target changed',
    (value) => ({ currentInput: { ...value, contract: { ...contract, target: 75001 } } }),
    'contract_changed',
  ],
  [
    'stale quote',
    (value) => ({ currentInput: { ...value, book: { ...value.book, receivedAt: NOW - 16000 } } }),
    'book_unavailable_or_noncausal',
  ],
])('rejects a %s response without creating an order', (name, patch, reason) => {
  const value = input();
  const evidence = getAdvisorCandidateEvidence(value);
  const decision = selection(evidence, 'BUY_YES');
  expect(
    validate(value, decision, { evidence, ...patch(value, evidence, decision) }),
  ).toMatchObject({ accepted: false, reason, advice: null, plan: null });
});

test('an originally available buy is vetoed if shared risk stops have since activated', () => {
  const value = input();
  const evidence = getAdvisorCandidateEvidence(value);
  const currentInput = {
    ...value,
    portfolio: { ...value.portfolio, riskHistory: { peakEquity: 115 } },
  };
  expect(validate(value, selection(evidence, 'BUY_YES'), { evidence, currentInput })).toMatchObject(
    { accepted: false, reason: 'selected_action_no_longer_available' },
  );
});

test('candidate exits cannot reuse an old quote, cross the computed limit, or change their frozen price', () => {
  const value = input({ position: true, probability: 0.5 });
  const evidence = getAdvisorCandidateEvidence(value);
  const advice = validate(value, selection(evidence, 'EXIT')).advice;
  const now = NOW + 2000;
  expect(
    simulateAdvisorCandidateExecution({
      advice,
      portfolio: value.portfolio,
      book: bookAt(NOW),
      now,
    }),
  ).toMatchObject({ kind: 'no-fill', reason: 'no_causal_execution_book' });
  expect(
    simulateAdvisorCandidateExecution({
      advice,
      portfolio: value.portfolio,
      book: { ...bookAt(now), noAsks: [{ price: 0.65, quantity: 100 }] },
      now,
    }),
  ).toMatchObject({ kind: 'no-fill', reason: 'limit_price_exceeded' });
  expect(
    simulateAdvisorCandidateExecution({
      advice: { ...advice, limitPrice: 0.01 },
      portfolio: value.portfolio,
      book: bookAt(now),
      now,
    }),
  ).toMatchObject({ kind: 'no-fill', reason: 'invalid_candidate_exit' });
});

test('only same-contract prior plans are included and stale reference data does not become a current target distance', () => {
  const value = input();
  value.forecast.referenceAt = NOW - 21000;
  value.lastPlan = {
    contract: { ...contract, target: contract.target + 1 },
    assessedAt: NOW - 1000,
    thesis: 'Old target thesis.',
  };
  const evidence = getAdvisorCandidateEvidence(value);
  expect(evidence.previousPlan).toBeNull();
  expect(evidence.points.at(-1).targetDistance).toBeNull();
});
