import { getAdvisorPortfolio, withAdvisorDailyEquity } from './tradingAdvisor.ledger';
import { getAdvisorValuation } from '@/features/BitcoinTracker/features/TradingAdvisor/utils/advisorValuation.utils';

/** Rebuild risk inputs from the actual account and this observation, including during replay. */
export function getAdvisorDecisionPortfolio({
  account,
  book,
  now,
  policy,
  riskHistory = null,
  releasedIntentId = null,
}) {
  const portfolio = getAdvisorPortfolio(account, now, releasedIntentId);
  if (policy.version !== 2) return portfolio;
  const valuation = getAdvisorValuation({ portfolio, books: book ? [book] : [], now, policy });
  return {
    ...getAdvisorPortfolio(withAdvisorDailyEquity(account, valuation, now), now, releasedIntentId),
    valuation,
    riskHistory,
  };
}
