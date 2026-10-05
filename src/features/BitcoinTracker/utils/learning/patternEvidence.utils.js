import { getKalshiContract, isVerifiedKalshiOutcome } from '../kalshi/contract.utils';

/** Reject a whole contract before row filtering can hide contradictory checkpoint evidence. */
export function getPatternContractConflicts(events = [], now = Date.now()) {
  const identities = new Map();
  const labels = new Map();
  const captures = new Map();
  const contractTickers = new Set();
  const reasons = {};
  const reject = (ticker, reason) => {
    contractTickers.add(ticker);
    reasons[ticker] ??= [];
    if (!reasons[ticker].includes(reason)) reasons[ticker].push(reason);
  };
  for (const event of events) {
    if (
      !['decision', 'outcome'].includes(event?.event) ||
      !Number.isSafeInteger(event.recordedAt) ||
      event.recordedAt <= 0 ||
      event.recordedAt > now
    )
      continue;
    const ticker = event.kalshiMarket?.ticker;
    if (typeof ticker !== 'string') continue;
    if (event.event === 'decision' && typeof event.forecastId === 'string') {
      const ids = captures.get(ticker) ?? new Set();
      ids.add(event.forecastId);
      captures.set(ticker, ids);
    }
    const contract = getKalshiContract(event.kalshiMarket);
    if (
      !contract ||
      event.target !== contract.target ||
      event.expiresAt !== contract.expiresAt ||
      event.windowStartAt !== contract.startsAt ||
      event.outcomeDefinition !== contract.outcomeDefinition
    ) {
      reject(ticker, 'inconsistent-contract-identity');
      continue;
    }
    const identity = JSON.stringify(contract);
    if (identities.has(ticker) && identities.get(ticker) !== identity)
      reject(ticker, 'conflicting-contract-identity');
    identities.set(ticker, identity);
    if (event.event !== 'outcome') continue;
    if (
      event.outcomeStatus === 'observed' &&
      event.kalshiOutcome &&
      (event.kalshiOutcome.marketTicker !== contract.ticker ||
        ['target', 'expiresAt', 'outcomeDefinition', 'comparison', 'roundDigits'].some(
          (key) => event.kalshiOutcome[key] !== contract[key],
        ))
    ) {
      reject(ticker, 'inconsistent-official-outcome-identity');
      continue;
    }
    if (!isVerifiedKalshiOutcome(event.kalshiOutcome, contract, event.recordedAt)) continue;
    const outcome = event.kalshiOutcome;
    // Some legacy withheld captures omitted redundant top-level confirmation metadata.
    // Absence is not a second label; provided values still must agree with verified evidence.
    const expected = {
      outcomeStatus: 'observed',
      outcome: outcome.outcome,
      observedPrice: outcome.observedPrice,
      observedAt: outcome.observedAt,
      confirmedThrough: outcome.confirmedThrough,
    };
    if (Object.keys(expected).some((key) => event[key] != null && event[key] !== expected[key]))
      reject(ticker, 'inconsistent-official-outcome');
    const label = `${outcome.result}:${outcome.observedPrice}`;
    if (labels.has(ticker) && labels.get(ticker) !== label)
      reject(ticker, 'conflicting-official-outcome');
    labels.set(ticker, label);
  }
  const forecastIds = new Set(
    [...contractTickers].flatMap((ticker) => [...(captures.get(ticker) ?? [])]),
  );
  return {
    contractTickers,
    forecastIds,
    rejectedContracts: contractTickers.size,
    rejectedCaptures: forecastIds.size,
    reasons,
  };
}
