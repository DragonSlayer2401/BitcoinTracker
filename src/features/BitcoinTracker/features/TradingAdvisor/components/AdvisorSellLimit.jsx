import { formatTime } from '../../../utils/format.utils';
import {
  formatAdvisorMoney,
  formatAdvisorQuantity,
  getAdvisorSideLabel,
} from '../utils/advisorDisplay.utils';

/** Price instructions describe a sale of this exact quantity, never an unplaced full-position exit. */
export default function AdvisorSellLimit({ advice, now }) {
  const isImmediateSale = advice.action === 'sell';
  const plan = isImmediateSale
    ? {
        side: advice.side,
        quantity: advice.quantity,
        limitPrice: advice.limitPrice,
        expiresAt: advice.validUntil,
        netProceeds: advice.expectedProceeds,
      }
    : advice.exitPlan;
  if (plan?.available === false && Number.isFinite(plan.expiresAt) && plan.expiresAt > now)
    return (
      <section className="advisor-exit-plan small mt-2" aria-label="Sell limit order">
        <h4 className="h6">No suitable sell limit</h4>
        <p className="mb-0">{plan.explanation}</p>
      </section>
    );
  if (
    !['buy', 'hold', 'sell'].includes(advice.action) ||
    !plan ||
    !Number.isFinite(plan.limitPrice) ||
    plan.limitPrice <= 0 ||
    plan.limitPrice >= 1 ||
    !Number.isFinite(plan.expiresAt) ||
    plan.expiresAt <= now
  )
    return null;
  const quantity = plan.quantity ?? advice.quantity;
  const side = getAdvisorSideLabel(plan.side ?? advice.side);
  if (!side || !Number.isSafeInteger(quantity) || quantity < 1) return null;
  const cents = Number((plan.limitPrice * 100).toFixed(2));
  return (
    <section className="advisor-exit-plan small mt-2" aria-label="Sell limit order">
      <div className="d-flex align-items-baseline justify-content-between gap-2">
        <h4 className="h6 mb-1">{isImmediateSale ? 'Sell limit now' : 'Your sell limit'}</h4>
        <strong className="fs-4">{cents}¢</strong>
      </div>
      {advice.action === 'buy' && (
        <span className="d-block text-secondary">After the entry fills:</span>
      )}
      <strong className="d-block">
        Sell {formatAdvisorQuantity(quantity)} {side} contracts at {cents}¢ or better.
      </strong>
      {Number.isFinite(plan.netProceeds) && (
        <span className="d-block mt-1">
          Estimated proceeds after fees: {formatAdvisorMoney(plan.netProceeds)}.
          {Number.isFinite(plan.estimatedProfit) && (
            <>
              {' '}
              Estimated net {plan.estimatedProfit < 0 ? 'loss' : 'profit'}:{' '}
              {formatAdvisorMoney(Math.abs(plan.estimatedProfit))}.
            </>
          )}
        </span>
      )}
      <span className="text-secondary d-block mt-1">
        {isImmediateSale
          ? 'Uses the latest available buyers.'
          : 'Fee-aware price at which selling would beat the estimated value of holding.'}{' '}
        Recheck by {formatTime(plan.expiresAt)}. This order is not placed; a fill is not guaranteed.
      </span>
    </section>
  );
}
