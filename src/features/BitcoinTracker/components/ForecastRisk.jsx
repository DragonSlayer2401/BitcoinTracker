import { useState } from 'react';
import { Button, Modal } from 'react-bootstrap';
import useRiskTrend from '../hooks/useRiskTrend';
import { formatPercent, formatPrice, formatTime } from '../utils/format.utils';
import { getReversalObservations, getReversalRisk } from '../utils/reversalRisk.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import KalshiPurchaseValue from './KalshiPurchaseValue';

export default function ForecastRisk({ forecast, fixedForecast, ticker, now, stream, conditions }) {
  const [show, setShow] = useState(false);
  const [showPurchaseValue, setShowPurchaseValue] = useState(false);
  const risk = getReversalRisk({ forecast, fixedForecast, ticker, now });
  const usesKalshi = fixedForecast?.outcomeDefinition === KALSHI_OUTCOME_DEFINITION;
  const getOutcomeLabel = (side) => (side === 'above' ? 'Yes' : 'No');
  const observations = risk.available ? getReversalObservations({ stream, conditions, now }) : [];
  const trend = useRiskTrend({
    id: fixedForecast?.id ? `${fixedForecast.id}:${risk.referenceSource ?? 'unavailable'}` : null,
    target: fixedForecast?.target,
    expiresAt: fixedForecast?.expiresAt,
    probability: risk.fixedFailureProbability,
    quoteTime: risk.referenceSource === 'cf-brti' ? risk.referenceAt : ticker?.time,
    now,
  });
  const hasFixedRisk = Number.isFinite(risk.fixedFailureProbability);
  const hasSavedProbabilities =
    [fixedForecast?.aboveProbability, fixedForecast?.belowProbability].every(
      (probability) => Number.isFinite(probability) && probability >= 0 && probability <= 1,
    ) && Math.abs(fixedForecast.aboveProbability + fixedForecast.belowProbability - 1) <= 0.000001;
  const savedLossRisk =
    hasFixedRisk && hasSavedProbabilities
      ? fixedForecast[`${risk.fixedFailureSide}Probability`]
      : null;
  const riskChange = Number.isFinite(savedLossRisk)
    ? Number(((risk.fixedFailureProbability - savedLossRisk) * 100).toFixed(1))
    : null;
  const changeLabel =
    riskChange === null ? '' : ` · ${riskChange > 0 ? '+' : ''}${riskChange.toFixed(1)} pp`;
  const baseLabel = hasFixedRisk
    ? `Fixed loss risk · ${formatPercent(risk.fixedFailureProbability)}${changeLabel}`
    : risk.available && Number.isFinite(risk.currentSideFlipProbability)
      ? `Reversal risk · ${formatPercent(risk.currentSideFlipProbability)}`
      : 'Forecast risk';
  const buttonLabel =
    hasFixedRisk && fixedForecast?.checkpointMinutes
      ? `${fixedForecast.checkpointMinutes}m call · ${baseLabel}`
      : baseLabel;

  return (
    <>
      <Button
        type="button"
        variant="link"
        size="sm"
        className="p-0 text-nowrap"
        title={riskChange === null ? undefined : 'Percentage-point change from the saved loss risk'}
        onClick={() => setShow(true)}
        aria-label={`${buttonLabel}${riskChange === null ? '' : ' from capture'}, view estimated deadline risk`}
      >
        {buttonLabel}
      </Button>
      <Modal
        show={show}
        onHide={() => {
          setShow(false);
          setShowPurchaseValue(false);
        }}
        className="tracker-modal"
        centered
        scrollable
        aria-labelledby="forecast-risk-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="forecast-risk-heading" as="h2" className="h5">
            Deadline and reversal risk
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Saved target {formatPrice(fixedForecast?.target)} · End{' '}
            {formatTime(fixedForecast?.expiresAt)}.{' '}
            {usesKalshi
              ? 'These estimates concern the rounded final-minute BRTI average and the official Kalshi result. A temporary crossing is a different event.'
              : 'These estimates concern the side at the deadline, not a temporary crossing.'}
          </p>
          {risk.available ? (
            <>
              <h3 className="h6">Risk to the fixed prediction</h3>
              {hasFixedRisk ? (
                <>
                  <p>
                    <strong>{formatPercent(risk.fixedFailureProbability)}</strong> estimated chance{' '}
                    {usesKalshi ? 'of settling ' : 'of finishing '}
                    <strong>
                      {usesKalshi ? getOutcomeLabel(risk.fixedFailureSide) : risk.fixedFailureSide}
                    </strong>
                    {usesKalshi
                      ? ', opposite the fixed '
                      : ' the saved target, opposite the fixed '}
                    <strong>
                      {usesKalshi
                        ? getOutcomeLabel(fixedForecast.direction)
                        : fixedForecast.direction}
                    </strong>{' '}
                    call.
                  </p>
                  {riskChange !== null ? (
                    <p className="small">
                      Saved loss risk <strong>{formatPercent(savedLossRisk)}</strong> → current{' '}
                      <strong>{formatPercent(risk.fixedFailureProbability)}</strong>.{' '}
                      {riskChange === 0
                        ? 'Unchanged at the displayed precision since capture.'
                        : `${riskChange > 0 ? 'Increased' : 'Decreased'} by ${Math.abs(riskChange).toFixed(1)} percentage points since capture.`}{' '}
                      This compares the same saved outcome using the current Yes/No estimate; the
                      fixed prediction has not changed.
                    </p>
                  ) : (
                    <p className="small text-secondary">
                      The original saved probabilities are unavailable, so a change since capture
                      cannot be calculated.
                    </p>
                  )}
                  <p className="small text-secondary">
                    {trend
                      ? Math.abs(trend.percentagePoints) < 1
                        ? `Changed by less than one percentage point over ${trend.elapsedSeconds} seconds.`
                        : `${trend.percentagePoints > 0 ? 'Increased' : 'Decreased'} by ${Math.abs(trend.percentagePoints).toFixed(1)} percentage points over ${trend.elapsedSeconds} seconds.`
                      : 'Collecting about one minute of continuous risk observations for a trend.'}
                  </p>
                </>
              ) : (
                <p className="small text-secondary">{risk.fixedReason}</p>
              )}
              <p className="small">
                {usesKalshi
                  ? `${risk.referenceLabel} ${formatPrice(risk.referencePrice)} is ${risk.currentSide === 'above' ? 'at or above' : 'below'} the saved target after rounding to cents.`
                  : `Currently ${risk.currentSide} the saved target.`}
                {risk.isAgainstFixedCall &&
                  (usesKalshi
                    ? ' The current reference price is on the side opposite the fixed call; the final-minute average can still settle differently.'
                    : ' Price is already on the side opposite the fixed call; it may still change before the deadline.')}
              </p>
              <h3 className="h6">Flip from the current side</h3>
              {risk.oppositeSide ? (
                <p>
                  <strong>{formatPercent(risk.currentSideFlipProbability)}</strong> estimated chance{' '}
                  {usesKalshi ? 'of settling ' : 'of finishing '}
                  <strong>
                    {usesKalshi ? getOutcomeLabel(risk.oppositeSide) : risk.oppositeSide}
                  </strong>
                  , opposite the current {usesKalshi ? 'reference price' : 'price'} side.
                </p>
              ) : (
                <p className="small text-secondary">
                  Price is exactly at the target, so there is no current side to flip from.
                </p>
              )}
              <p className="small">
                {usesKalshi ? 'Kalshi Yes (≥ target)' : 'Ending above'}:{' '}
                <strong>{formatPercent(risk.aboveProbability)}</strong> ·{' '}
                {usesKalshi ? 'Kalshi No (< target)' : 'Ending below'}:{' '}
                <strong>{formatPercent(risk.belowProbability)}</strong>
              </p>
              <h3 className="h6">Observed changes</h3>
              {observations.length ? (
                <ul className="small">
                  {observations.map((observation) => (
                    <li key={observation.code}>{observation.text}</li>
                  ))}
                </ul>
              ) : (
                <p className="small text-secondary">
                  No reversal-specific change is available from the current inputs. This does not
                  mean the chance of a flip is zero.
                </p>
              )}
              <p className="small text-secondary">
                These observations describe market activity; they do not establish its cause or add
                separate percentage bonuses. Risk uses the same ending probabilities for the saved
                target and deadline.{' '}
                {usesKalshi
                  ? 'Coinbase activity informs the estimate; settlement uses Kalshi’s BRTI rules.'
                  : 'Editing the preview target does not change this reference.'}
              </p>
            </>
          ) : (
            <p>{risk.reason}</p>
          )}
          <p className="small text-secondary mb-0">
            Estimated probabilities are not a validated success rate. The captured fixed prediction
            stays unchanged as this live risk updates.{' '}
            {usesKalshi
              ? 'A settlement average that rounds to the target counts as Yes.'
              : 'The model does not assign a separate probability to an exact-price tie.'}
          </p>
          {usesKalshi && (
            <div className="border-top mt-3 pt-3">
              <Button
                type="button"
                variant="outline-secondary"
                size="sm"
                aria-expanded={showPurchaseValue}
                onClick={() => setShowPurchaseValue((value) => !value)}
              >
                {showPurchaseValue ? 'Hide purchase value' : 'Compare purchase value'}
              </Button>
              {show && showPurchaseValue && (
                <KalshiPurchaseValue
                  contract={fixedForecast?.kalshiMarket}
                  aboveProbability={risk.available ? risk.aboveProbability : null}
                  now={now}
                />
              )}
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button
            type="button"
            variant="outline-secondary"
            onClick={() => {
              setShow(false);
              setShowPurchaseValue(false);
            }}
          >
            Close forecast risk
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
