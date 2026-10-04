import { getKalshiContract, isSameKalshiContract } from '../../../utils/kalshi/contract.utils';
import {
  getTradingAdvice,
  getTradingBookProblem,
  getTradingExecutionQuote,
  getTradingPortfolioProblem,
  getTradingQuoteAmounts,
  isTradingAdvisorPolicy,
  simulateTradingExecution,
} from './tradingAdvisor.utils';

export const ADVISOR_CANDIDATE_VERSIONS = Object.freeze({
  rules: 'history-rules-v1',
  llm: 'history-llm-v1',
  exit: 'history-exit-v1',
});
export const ADVISOR_CANDIDATE_LIMITS = Object.freeze({
  historyPoints: 12,
  historyMs: 180000,
  responseAgeMs: 30000,
  planAgeMs: 30000,
});
const actions = ['BUY_YES', 'BUY_NO', 'HOLD', 'REDUCE', 'EXIT', 'NO_TRADE'];
const reviews = ['next-quote', '15s', '30s', '60s'];
const string = (maxLength) => ({ type: 'string', minLength: 1, maxLength });
const narrative = (maxLength) => ({ ...string(maxLength), pattern: '^[^0-9$%€£]+$' });
export const ADVISOR_CANDIDATE_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: actions },
    optionId: string(80),
    snapshotId: string(160),
    evidenceRefs: { type: 'array', minItems: 1, maxItems: 16, items: string(160) },
    rationale: narrative(600),
    thesis: narrative(600),
    invalidationConditions: { type: 'array', minItems: 1, maxItems: 5, items: narrative(180) },
    reviewHorizon: { type: 'string', enum: reviews },
  },
  required: [
    'action',
    'optionId',
    'snapshotId',
    'evidenceRefs',
    'rationale',
    'thesis',
    'invalidationConditions',
    'reviewHorizon',
  ],
});
const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const timestamp = (value) => Number.isSafeInteger(value) && value > 0;
const money = (value) => Math.round(value * 1e6) / 1e6;
const text = (value, maximum = 600) => (typeof value === 'string' ? value.slice(0, maximum) : null);
const copy = (value) => JSON.parse(JSON.stringify(value));
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
};
const boundedText = (value, maximum) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= maximum;
const qualitativeText = (value, maximum) => boundedText(value, maximum) && !/[0-9$%€£]/.test(value);
const samePolicy = (left, right) =>
  left &&
  right &&
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([key, value]) => right[key] === value);

/** Parse only a selection and its explanation. Numbers remain supplied by market/account code. */
export function isAdvisorCandidateOutputShape(value) {
  const keys = ADVISOR_CANDIDATE_OUTPUT_SCHEMA.required;
  return Boolean(
    value &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key)) &&
    actions.includes(value.action) &&
    boundedText(value.optionId, 80) &&
    boundedText(value.snapshotId, 160) &&
    qualitativeText(value.rationale, 600) &&
    qualitativeText(value.thesis, 600) &&
    reviews.includes(value.reviewHorizon) &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.length >= 1 &&
    value.evidenceRefs.length <= 16 &&
    value.evidenceRefs.every((item) => boundedText(item, 160)) &&
    new Set(value.evidenceRefs).size === value.evidenceRefs.length &&
    Array.isArray(value.invalidationConditions) &&
    value.invalidationConditions.length >= 1 &&
    value.invalidationConditions.length <= 5 &&
    value.invalidationConditions.every((item) => qualitativeText(item, 180)),
  );
}

function getForecastProblem(forecast, contract, now) {
  return !forecast?.available ||
    !finite(forecast.aboveProbability) ||
    forecast.aboveProbability < 0 ||
    forecast.aboveProbability > 1 ||
    !timestamp(forecast.capturedAt) ||
    forecast.capturedAt > now ||
    now - forecast.capturedAt > 5000 ||
    !boundedText(forecast.modelVersion, 160) ||
    (forecast.contract && !isSameKalshiContract(forecast.contract, contract)) ||
    (forecast.marketTicker && forecast.marketTicker !== contract.ticker)
    ? 'forecast_unavailable_or_stale'
    : null;
}

function getMarketPoint(
  { snapshotId, contract, forecast, book, observedAt, advice, plan },
  policy,
) {
  if (
    !boundedText(snapshotId, 160) ||
    !timestamp(observedAt) ||
    getForecastProblem(forecast, contract, observedAt) ||
    getTradingBookProblem({ contract, book, now: observedAt })
  )
    return null;
  const quote = (action, side) =>
    getTradingExecutionQuote({
      action,
      side,
      quantity: 1,
      contract,
      book,
      now: observedAt,
      policy,
    });
  const buyYes = quote('buy', 'yes');
  const buyNo = quote('buy', 'no');
  const sellYes = quote('sell', 'yes');
  const sellNo = quote('sell', 'no');
  const rawPrice = forecast.referencePrice ?? forecast.kalshi?.referencePrice;
  const referenceAt = forecast.referenceAt ?? forecast.kalshi?.referenceAt;
  const referencePrice =
    finite(rawPrice) &&
    rawPrice > 0 &&
    timestamp(referenceAt) &&
    referenceAt <= observedAt &&
    observedAt - referenceAt <= 20000
      ? rawPrice
      : null;
  return {
    id: `${snapshotId}:market`,
    snapshotId,
    observedAt,
    aboveProbability: forecast.aboveProbability,
    modelVersion: forecast.modelVersion,
    referencePrice,
    referenceAt: referencePrice === null ? null : referenceAt,
    target: contract.target,
    targetDistance: referencePrice === null ? null : money(referencePrice - contract.target),
    remainingMs: Math.max(0, contract.expiresAt - observedAt),
    minuteVolatility: finite(forecast.minuteVolatility ?? forecast.kalshi?.minuteVolatility)
      ? (forecast.minuteVolatility ?? forecast.kalshi.minuteVolatility)
      : null,
    horizonVolatility: finite(forecast.volatility) ? forecast.volatility : null,
    yesBuyCost: buyYes.available ? buyYes.totalCost : null,
    noBuyCost: buyNo.available ? buyNo.totalCost : null,
    yesSaleNet: sellYes.available ? sellYes.netProceeds : null,
    noSaleNet: sellNo.available ? sellNo.netProceeds : null,
    yesBuyFee: buyYes.available ? buyYes.fee : null,
    noBuyFee: buyNo.available ? buyNo.fee : null,
    yesAskDepth: book.yesAsks.reduce((sum, level) => sum + level.quantity, 0),
    noAskDepth: book.noAsks.reduce((sum, level) => sum + level.quantity, 0),
    recommendation: text(plan?.action ?? advice?.action, 40),
    rationale: text(plan?.rationale ?? advice?.reason),
  };
}

/** One bounded, causal view of this exact target and expiry. Market text is evidence, never instructions. */
export function getAdvisorCandidateEvidence({
  snapshotId,
  contract,
  forecast,
  book,
  portfolio,
  now,
  policy,
  history = [],
  lastPlan = null,
}) {
  const base = {
    version: 'advisor-candidate-evidence-v1',
    available: false,
    reason: null,
    snapshotId,
    observedAt: now,
    expiresAt: timestamp(now) ? now + ADVISOR_CANDIDATE_LIMITS.responseAgeMs : null,
    accountVersion: portfolio?.accountVersion ?? null,
    contract: getKalshiContract(contract),
    points: [],
    options: [],
    evidenceIds: [],
  };
  const unavailable = (reason) => freeze({ ...base, reason });
  if (
    !boundedText(snapshotId, 140) ||
    !timestamp(now) ||
    !base.contract ||
    !isTradingAdvisorPolicy(policy)
  )
    return unavailable('invalid_candidate_input');
  if (now < contract.startsAt || now >= contract.expiresAt)
    return unavailable('outside_active_contract');
  if (!Number.isSafeInteger(portfolio?.accountVersion) || portfolio.accountVersion < 0)
    return unavailable('account_version_unavailable');
  const problem =
    getForecastProblem(forecast, contract, now) ||
    getTradingBookProblem({ contract, book, now }) ||
    getTradingPortfolioProblem(portfolio);
  if (problem) return unavailable(problem);
  const currentPoint = getMarketPoint(
    { snapshotId, contract, forecast, book, observedAt: now },
    policy,
  );
  const seen = new Set([snapshotId]);
  const points = (Array.isArray(history) ? history.slice(-120) : [])
    .filter(
      (row) =>
        row &&
        isSameKalshiContract(row.contract, contract) &&
        timestamp(row.observedAt) &&
        row.observedAt < now &&
        now - row.observedAt <= ADVISOR_CANDIDATE_LIMITS.historyMs,
    )
    .sort((left, right) => right.observedAt - left.observedAt)
    .flatMap((row) => {
      if (seen.has(row.snapshotId)) return [];
      const point = getMarketPoint(row, policy);
      if (!point) return [];
      seen.add(row.snapshotId);
      return [point];
    })
    .slice(0, ADVISOR_CANDIDATE_LIMITS.historyPoints - 1)
    .reverse();
  points.push(currentPoint);
  const matching = portfolio.positions.filter(
    (position) => position.contract.ticker === contract.ticker,
  );
  if (
    matching.some((position) => !isSameKalshiContract(position.contract, contract)) ||
    matching.length > 1
  )
    return unavailable('position_contract_mismatch');
  const position = matching[0] ?? null;
  const current = getTradingAdvice({ contract, forecast, book, portfolio, now, policy });
  const canonical = (patch) => ({
    ...copy(current),
    action: 'wait',
    side: null,
    quantity: 0,
    limitPrice: null,
    maxCost: null,
    expectedNetValue: null,
    conservativeExpectedNetValue: null,
    quotedCost: null,
    quotedFee: null,
    expectedProceeds: null,
    minimumNetProceeds: null,
    holdExpectedValue: null,
    positionId: null,
    exitPlan: null,
    ...patch,
  });
  const options = [];
  if (!position) {
    options.push({
      id: 'no-trade',
      action: 'NO_TRADE',
      advice: canonical({
        reason: current.action === 'buy' ? 'candidate_no_trade' : current.reason,
      }),
    });
    if (current.action === 'buy')
      options.push({
        id: `buy-${current.side}`,
        action: current.side === 'yes' ? 'BUY_YES' : 'BUY_NO',
        advice: copy(current),
      });
  } else {
    const quantity = Math.min(position.availableQuantity ?? position.quantity, policy.maxContracts);
    const probability =
      position.side === 'yes' ? forecast.aboveProbability : 1 - forecast.aboveProbability;
    const hold = canonical({
      action: 'hold',
      side: position.side,
      quantity: position.quantity,
      probability,
      positionId: position.id,
      holdExpectedValue: money(position.quantity * probability),
      reason: 'candidate_thesis_holds',
      exitPlan: current.exitPlan,
    });
    options.push({ id: `hold-${position.side}`, action: 'HOLD', advice: hold });
    if (
      quantity > 0 &&
      !portfolio.pendingIntents?.some((intent) => intent.contract?.ticker === contract.ticker)
    ) {
      const sizes =
        quantity < position.quantity
          ? [{ action: 'REDUCE', quantity }]
          : quantity > 1
            ? [
                { action: 'REDUCE', quantity: Math.max(1, Math.floor(quantity / 2)) },
                { action: 'EXIT', quantity },
              ]
            : [{ action: 'EXIT', quantity }];
      for (const size of sizes) {
        const sale = getTradingExecutionQuote({
          action: 'sell',
          side: position.side,
          quantity: size.quantity,
          contract,
          book,
          now,
          policy,
        });
        if (!sale.available) continue;
        const limitPrice =
          Math.floor((Math.min(...sale.fills.map((fill) => fill.price)) + 1e-10) * 100) / 100;
        const amounts =
          limitPrice > 0
            ? getTradingQuoteAmounts(
                [{ price: limitPrice, quantity: size.quantity }],
                'sell',
                book.fee,
                now,
              )
            : null;
        if (!amounts || amounts.netProceeds <= 0) continue;
        options.push({
          id: `${size.action.toLowerCase()}-${position.side}`,
          action: size.action,
          advice: canonical({
            action: 'sell',
            side: position.side,
            quantity: size.quantity,
            probability,
            positionId: position.id,
            limitPrice,
            maxCost: 0,
            expectedProceeds: sale.netProceeds,
            quotedFee: sale.fee,
            minimumNetProceeds: amounts.netProceeds,
            expectedNetValue: money(sale.netProceeds - probability * size.quantity),
            conservativeExpectedNetValue: money(
              sale.netProceeds - (probability + policy.probabilityReserve) * size.quantity,
            ),
            holdExpectedValue: money(probability * size.quantity),
            reason: size.action === 'EXIT' ? 'candidate_exit_thesis' : 'candidate_reduce_thesis',
            candidateExit: {
              version: ADVISOR_CANDIDATE_VERSIONS.exit,
              quantity: size.quantity,
              minimumNetProceeds: amounts.netProceeds,
              limitPrice,
              observedAt: now,
              fee: {
                available: book.fee.available,
                type: book.fee.type,
                multiplier: book.fee.multiplier,
                checkedAt: book.fee.checkedAt,
                validUntil: book.fee.validUntil,
              },
            },
          }),
        });
      }
    }
  }
  const previousPlan =
    lastPlan &&
    isSameKalshiContract(lastPlan.contract, contract) &&
    timestamp(lastPlan.assessedAt) &&
    lastPlan.assessedAt <= now
      ? {
          id: `${snapshotId}:previous-plan`,
          action: text(lastPlan.action, 40),
          thesis: text(lastPlan.thesis),
          rationale: text(lastPlan.rationale),
          invalidationConditions: Array.isArray(lastPlan.invalidationConditions)
            ? lastPlan.invalidationConditions
                .slice(0, 5)
                .map((item) => text(item, 180))
                .filter(Boolean)
            : [],
          assessedAt: lastPlan.assessedAt,
          expired: !timestamp(lastPlan.expiresAt) || lastPlan.expiresAt <= now,
        }
      : null;
  const positionEvidence = position
    ? {
        id: `${snapshotId}:position`,
        positionId: position.id,
        side: position.side,
        quantity: position.quantity,
        availableQuantity: position.availableQuantity ?? position.quantity,
        costBasis: finite(position.costBasis) ? position.costBasis : null,
        averagePrice: finite(position.averagePrice) ? position.averagePrice : null,
        ageMs:
          timestamp(position.openedAt) && position.openedAt <= now ? now - position.openedAt : null,
        entryRationale: text(position.entryRationale ?? position.entryReason),
        entryThesis: text(position.entryThesis),
        entryProbability: finite(position.entryProbability) ? position.entryProbability : null,
      }
    : null;
  const account = {
    id: `${snapshotId}:account`,
    version: portfolio.accountVersion,
    cash: portfolio.cash,
    reservedCapital: portfolio.reservedCapital ?? null,
    openRisk: portfolio.openRisk,
    realizedPnl: portfolio.realizedPnl ?? null,
    executableEquity: portfolio.valuation?.complete ? portfolio.valuation.executableEquity : null,
    drawdown: portfolio.riskHistory?.drawdown ?? null,
    pendingOrderCount: portfolio.pendingIntents?.length ?? 0,
    blocker: current.action === 'wait' ? current.reason : null,
  };
  return freeze({
    ...base,
    available: true,
    expiresAt: Math.min(base.expiresAt, contract.expiresAt),
    policy: copy(policy),
    points,
    account,
    position: positionEvidence,
    previousPlan,
    probabilityChange: money(currentPoint.aboveProbability - points[0].aboveProbability),
    options,
    evidenceIds: [
      ...points.map((point) => point.id),
      account.id,
      ...(positionEvidence ? [positionEvidence.id] : []),
      ...(previousPlan ? [previousPlan.id] : []),
    ],
  });
}

/** A fixed rules challenger tests persistence and separate exit thresholds without imposing a minimum hold. */
export function getHistoryRulesDecision(evidence) {
  if (!evidence?.available) return null;
  const { points, options, position, policy } = evidence;
  const recent = points.slice(-3);
  const current = points[points.length - 1];
  let selected = options.find((option) => option.action === (position ? 'HOLD' : 'NO_TRADE'));
  let rationale = position
    ? 'The available evidence has not invalidated the holding thesis. A brief pullback alone is insufficient to exit.'
    : 'Observe persistent executable entry value before committing paper capital.';
  if (!position) {
    const buy = options.find((option) => option.advice.action === 'buy');
    if (
      buy &&
      recent.length >= 3 &&
      current.observedAt - recent[0].observedAt >= 30000 &&
      recent.every((point) => {
        const probability =
          buy.advice.side === 'yes' ? point.aboveProbability : 1 - point.aboveProbability;
        const cost = point[buy.advice.side === 'yes' ? 'yesBuyCost' : 'noBuyCost'];
        return (
          finite(cost) && probability - policy.probabilityReserve - cost >= policy.minimumEntryEdge
        );
      })
    ) {
      selected = buy;
      rationale =
        'The entry advantage persisted across separate observations and still clears code-calculated costs and risk limits.';
    }
  } else {
    const held = (point) =>
      position.side === 'yes' ? point.aboveProbability : 1 - point.aboveProbability;
    const probability = held(current);
    const drop = recent.length >= 2 ? held(recent[0]) - probability : 0;
    const shock = recent.length >= 2 && held(recent[recent.length - 2]) - probability >= 0.2;
    const persistent =
      recent.length >= 3 &&
      current.observedAt - recent[0].observedAt >= 30000 &&
      recent.every((point, index) => index === 0 || held(point) <= held(recent[index - 1]) + 0.01);
    const exit = options.find((option) => option.action === 'EXIT');
    const reduce = options.find((option) => option.action === 'REDUCE');
    const saleValue = exit ? exit.advice.expectedProceeds / exit.advice.quantity : null;
    const nearExpiry = current.remainingMs <= 60000;
    if (
      exit &&
      ((nearExpiry && saleValue >= probability - 0.03) ||
        ((shock || (persistent && drop >= 0.1)) && saleValue >= probability - 0.02))
    ) {
      selected = exit;
      rationale = nearExpiry
        ? 'Expiry is close and the executable sale value is competitive with holding after costs.'
        : 'The probability evidence materially deteriorated and the current exit avoids relying on the original thesis recovering.';
    } else if (
      exit &&
      saleValue - probability >= 0.025 &&
      recent.length >= 2 &&
      recent
        .slice(-2)
        .every(
          (point) =>
            finite(point[position.side === 'yes' ? 'yesSaleNet' : 'noSaleNet']) &&
            point[position.side === 'yes' ? 'yesSaleNet' : 'noSaleNet'] - held(point) >= 0.01,
        )
    ) {
      selected = exit;
      rationale =
        'Selling has persistently offered a better estimated value than holding after costs.';
    } else if (
      reduce &&
      persistent &&
      drop >= 0.06 &&
      reduce.advice.expectedProceeds / reduce.advice.quantity >= probability - 0.05
    ) {
      selected = reduce;
      rationale =
        'The thesis weakened across several observations; reducing exposure is available without assuming the original entry cost will be recovered.';
    }
  }
  if (!selected) return null;
  return freeze({
    action: selected.action,
    optionId: selected.id,
    snapshotId: evidence.snapshotId,
    evidenceRefs: [
      ...recent.map((point) => point.id),
      evidence.account.id,
      ...(position ? [position.id] : []),
    ],
    rationale,
    thesis: position
      ? 'Continue only while fresh probability and executable exit evidence support the position; the original entry price is not a reason to hold.'
      : 'Enter only when an observed advantage survives costs, repeated observations and the account risk limits.',
    invalidationConditions: [
      'Fresh evidence materially weakens the selected side.',
      'Executable prices, remaining time or account risk no longer support this plan.',
    ],
    reviewHorizon: '15s',
  });
}

/** Reprice a model-selected option against fresh evidence; no model-supplied number enters an order. */
export function validateAdvisorCandidateDecision({
  decision,
  evidence,
  currentInput,
  candidatePolicyVersion,
  receivedAt,
  now,
}) {
  const veto = (reason) => freeze({ accepted: false, reason, advice: null, plan: null });
  if (!Object.values(ADVISOR_CANDIDATE_VERSIONS).slice(0, 2).includes(candidatePolicyVersion))
    return veto('unknown_candidate_policy');
  if (!isAdvisorCandidateOutputShape(decision)) return veto('invalid_candidate_output');
  if (
    !evidence?.available ||
    decision.snapshotId !== evidence.snapshotId ||
    !evidence.options.some(
      (option) => option.id === decision.optionId && option.action === decision.action,
    )
  )
    return veto('unknown_snapshot_or_option');
  if (!decision.evidenceRefs.every((id) => evidence.evidenceIds.includes(id)))
    return veto('unknown_evidence_reference');
  if (
    !timestamp(now) ||
    !timestamp(receivedAt) ||
    receivedAt < evidence.observedAt ||
    receivedAt > now ||
    now >= evidence.expiresAt
  )
    return veto('expired_or_noncausal_response');
  if (currentInput?.activeSnapshotId && currentInput.activeSnapshotId !== evidence.snapshotId)
    return veto('superseded_snapshot');
  if (!isSameKalshiContract(currentInput?.contract, evidence.contract))
    return veto('contract_changed');
  if (currentInput?.portfolio?.accountVersion !== evidence.accountVersion)
    return veto('account_changed');
  if (!samePolicy(currentInput?.policy, evidence.policy)) return veto('policy_changed');
  const fresh = getAdvisorCandidateEvidence({
    ...currentInput,
    snapshotId: evidence.snapshotId,
    now,
  });
  if (!fresh.available) return veto(fresh.reason);
  const choice = fresh.options.find(
    (option) => option.id === decision.optionId && option.action === decision.action,
  );
  if (!choice) return veto('selected_action_no_longer_available');
  const interval =
    decision.reviewHorizon === 'next-quote'
      ? 1000
      : Number.parseInt(decision.reviewHorizon, 10) * 1000;
  const expiresAt = Math.min(now + ADVISOR_CANDIDATE_LIMITS.planAgeMs, evidence.contract.expiresAt);
  const plan = {
    version: 'advisor-candidate-plan-v1',
    candidatePolicyVersion,
    snapshotId: evidence.snapshotId,
    contract: copy(evidence.contract),
    action: choice.action,
    side: choice.advice.side,
    quantity: choice.advice.quantity,
    limitPrice: choice.advice.limitPrice,
    rationale: decision.rationale,
    thesis: decision.thesis,
    invalidationConditions: copy(decision.invalidationConditions),
    evidenceRefs: copy(decision.evidenceRefs),
    assessedAt: now,
    nextReviewAt: Math.min(now + interval, expiresAt),
    expiresAt,
    status: 'active',
  };
  const advice = {
    ...copy(choice.advice),
    candidatePolicyVersion,
    candidateSnapshotId: evidence.snapshotId,
    candidateAction: choice.action,
    candidateDecision: copy(decision),
    candidatePlan: plan,
    evaluatedAt: now,
    validUntil: Math.min(now + currentInput.policy.cadenceMs, expiresAt),
  };
  return freeze({ accepted: true, reason: null, advice, plan });
}

/** Candidate exits share causality, prices, fees, inventory and IOC accounting, with a frozen separate exit rule. */
export function simulateAdvisorCandidateExecution({
  advice,
  book,
  portfolio,
  now,
  policy = advice?.policy,
}) {
  if (advice?.action !== 'sell')
    return simulateTradingExecution({ advice, book, portfolio, now, policy });
  if (
    !isTradingAdvisorPolicy(policy) ||
    !timestamp(now) ||
    !timestamp(advice.evaluatedAt) ||
    !samePolicy(advice.policy, policy) ||
    ![ADVISOR_CANDIDATE_VERSIONS.rules, ADVISOR_CANDIDATE_VERSIONS.llm].includes(
      advice.candidatePolicyVersion,
    ) ||
    !['REDUCE', 'EXIT'].includes(advice.candidateAction) ||
    advice.candidateExit?.version !== ADVISOR_CANDIDATE_VERSIONS.exit ||
    advice.policyId !== policy.id ||
    !getKalshiContract(advice.contract)
  )
    return null;
  if (now < advice.evaluatedAt + policy.minimumFillDelayMs) return null;
  const base = {
    kind: 'no-fill',
    action: 'sell',
    side: advice.side,
    quantity: 0,
    price: null,
    cost: 0,
    fee: 0,
    totalCost: 0,
    proceeds: 0,
    netProceeds: 0,
    positionId: advice.positionId,
    recordedAt: now,
    book: copy(book ?? null),
    fills: [],
    ...(policy.version === 2
      ? {
          requestedQuantity: advice.quantity,
          canceledQuantity: advice.quantity,
          timeInForce: 'IOC',
          fullyCovered: false,
          dailyEquity: {
            day: portfolio?.equityDay ?? null,
            startEquity: portfolio?.dailyStartEquity ?? null,
          },
        }
      : {}),
  };
  const noFill = (reason) => freeze({ ...base, reason });
  if (now > advice.evaluatedAt + policy.maximumFillDelayMs || now >= advice.contract.expiresAt)
    return noFill('execution_window_expired');
  if (
    !timestamp(book?.requestedAt) ||
    book.requestedAt < advice.evaluatedAt + policy.minimumFillDelayMs ||
    !timestamp(book?.receivedAt) ||
    book.receivedAt < book.requestedAt
  )
    return noFill('no_causal_execution_book');
  const problem =
    getTradingBookProblem({ contract: advice.contract, book, now }) ||
    getTradingPortfolioProblem(portfolio);
  if (problem) return noFill(problem);
  const position = portfolio.positions.find((item) => item.id === advice.positionId);
  if (
    !position ||
    position.side !== advice.side ||
    !isSameKalshiContract(position.contract, advice.contract) ||
    !Number.isSafeInteger(advice.quantity) ||
    advice.quantity < 1 ||
    advice.quantity > Math.min(policy.maxContracts, position.availableQuantity ?? position.quantity)
  )
    return noFill('position_unavailable');
  if (
    !finite(advice.limitPrice) ||
    advice.limitPrice <= 0 ||
    advice.limitPrice >= 1 ||
    !finite(advice.minimumNetProceeds) ||
    advice.minimumNetProceeds <= 0 ||
    advice.candidateExit.quantity !== advice.quantity ||
    advice.candidateExit.minimumNetProceeds !== advice.minimumNetProceeds ||
    advice.candidateExit.limitPrice !== advice.limitPrice ||
    advice.candidateExit.observedAt !== advice.evaluatedAt
  )
    return noFill('invalid_candidate_exit');
  const originalMinimum = getTradingQuoteAmounts(
    [{ price: advice.limitPrice, quantity: advice.quantity }],
    'sell',
    advice.candidateExit.fee,
    advice.evaluatedAt,
  );
  if (!originalMinimum || originalMinimum.netProceeds !== advice.minimumNetProceeds)
    return noFill('invalid_candidate_exit');
  let selected = null;
  let reason = 'insufficient_execution_depth';
  const firstQuantity = policy.version === 2 ? 1 : advice.quantity;
  for (let quantity = firstQuantity; quantity <= advice.quantity; quantity += 1) {
    const quote = getTradingExecutionQuote({
      action: 'sell',
      side: advice.side,
      quantity,
      contract: advice.contract,
      book,
      now,
      policy,
    });
    if (!quote.available) {
      reason = quote.reason;
      break;
    }
    if (quote.fills.some((fill) => fill.price < advice.limitPrice - 1e-8)) {
      reason = 'limit_price_exceeded';
      break;
    }
    const minimum = getTradingQuoteAmounts(
      [{ price: advice.limitPrice, quantity }],
      'sell',
      advice.candidateExit.fee,
      advice.evaluatedAt,
    );
    if (!minimum || minimum.netProceeds <= 0 || quote.netProceeds < minimum.netProceeds - 1e-8) {
      reason = 'execution_value_lost';
      continue;
    }
    selected = quote;
  }
  if (!selected) return noFill(reason);
  return freeze({
    ...base,
    ...selected,
    kind: 'fill',
    price: selected.averagePrice,
    ...(policy.version === 2
      ? {
          fullyCovered: selected.quantity === advice.quantity,
          canceledQuantity: advice.quantity - selected.quantity,
        }
      : {}),
    reason:
      selected.quantity === advice.quantity
        ? 'candidate_delayed_snapshot_simulation'
        : 'candidate_partial_fill_remainder_canceled',
  });
}
