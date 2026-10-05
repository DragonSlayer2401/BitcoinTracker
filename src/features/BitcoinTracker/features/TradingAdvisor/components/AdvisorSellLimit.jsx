import { formatTime } from '../../../utils/format.utils';
import {
  formatAdvisorMoney,
  formatAdvisorQuantity,
  getAdvisorSideLabel,
} from '../utils/advisorDisplay.utils';

/** The parent keeps standing targets tied to the active plan; immediate sales need a fresh quote. */
export default function AdvisorSellLimit({
  advice,
  now,
  isStandingPlan = false,
  availableQuantity,
}) {
  if (!['buy', 'hold', 'sell'].includes(advice?.action)) return null;
  const isImmediateSale = advice.action === 'sell';
  const isStandingExit = isStandingPlan && !isImmediateSale;
  const plan = isImmediateSale
    ? {
        side: advice.side,
        quantity: advice.quantity,
        limitPrice: advice.limitPrice,
        expiresAt: advice.validUntil,
        netProceeds: advice.expectedProceeds,
      }
    : advice.exitPlan;
  if (
    !plan ||
    !Number.isFinite(plan.expiresAt) ||
    plan.expiresAt <= 0 ||
    (!isStandingExit && plan.expiresAt <= now) ||
    (Number.isFinite(advice.contract?.expiresAt) && advice.contract.expiresAt <= now)
  )
    return null;
  const quantity = plan.quantity ?? advice.quantity;
  const planSide = plan.side ?? advice.side;
  const side = getAdvisorSideLabel(planSide);
  if (
    !side ||
    planSide !== advice.side ||
    !Number.isSafeInteger(quantity) ||
    quantity < 1 ||
    !Number.isSafeInteger(advice.quantity) ||
    quantity > advice.quantity
  )
    return null;
  if (plan.available === false)
    return (
      <section className="advisor-exit-plan small mt-2" aria-label="Sell limit order">
        <h4 className="h6">
          {advice.action === 'hold'
            ? 'Hold; no suitable sell limit'
            : 'No suitable sell limit after entry'}
        </h4>
        <p className="mb-0">{plan.explanation}</p>
      </section>
    );
  if (!Number.isFinite(plan.limitPrice) || plan.limitPrice <= 0 || plan.limitPrice >= 1)
    return null;
  if (
    isStandingExit &&
    advice.action === 'hold' &&
    Number.isFinite(availableQuantity) &&
    quantity > availableQuantity
  )
    return (
      <section className="advisor-exit-plan small mt-2" aria-label="Sell limit order">
        <h4 className="h6">Sell order already pending</h4>
        <p className="mb-0">
          Some of this position is already reserved. No additional sell order is suggested while the
          adviser reviews the remaining quantity.
        </p>
      </section>
    );
  const cents = Number((plan.limitPrice * 100).toFixed(2));
  return (
    <section className="advisor-exit-plan small mt-2" aria-label="Sell limit order">
      <div className="d-flex align-items-baseline justify-content-between gap-2">
        <h4 className="h6 mb-1">Set a sell limit at {cents}¢</h4>
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
        {!isStandingExit && <>Recheck by {formatTime(plan.expiresAt)}. </>}
        No order has been placed. A fill needs a buyer at your limit or better.
      </span>
      <details className="mt-2">
        <summary>Limit orders and stops</summary>
        <p className="mb-0 mt-1">
          A sell limit below the current bid can fill immediately. It is not a stop-loss order. This
          plan does not place either order.
        </p>
      </details>
    </section>
  );
}
