import { Button } from 'react-bootstrap';
import { formatCountdown, formatDateTime, formatPercent, formatPrice } from '../utils/format.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';

export default function ForecastStatus({
  activeForecast,
  completedForecast,
  schedule,
  now,
  onCancelSchedule,
  previewEndsAt,
  showRecordedDetails = true,
}) {
  const isIdle = !activeForecast && !completedForecast && !schedule;
  const isMissed = schedule?.status === 'missed';
  const isAnalyzing = activeForecast?.status === 'analyzing';
  const isWithheld = completedForecast?.status === 'withheld';
  const isStarting = schedule?.status === 'scheduled' && now >= schedule.startsAt;
  const isSettling = activeForecast && now >= activeForecast.expiresAt;
  const entry = activeForecast || completedForecast || schedule;
  const currentTime = Number.isFinite(now) ? now : (entry?.createdAt ?? 0);
  const hasEndPreview = isIdle && previewEndsAt !== undefined;
  const isPreviewEndValid = Number.isSafeInteger(previewEndsAt) && previewEndsAt >= 0;
  const hasPreviewClock = Number.isSafeInteger(now) && now >= 0;
  const previewRemaining = isPreviewEndValid && hasPreviewClock ? previewEndsAt - now : null;
  const previewCaption = !isPreviewEndValid
    ? 'Choose a valid end time'
    : !hasPreviewClock
      ? 'Waiting for current time'
      : previewRemaining <= 0
        ? 'Selected end has passed'
        : previewRemaining > 900_000
          ? 'Waiting for 15-minute window'
          : 'Until selected end';
  const remaining = isWithheld
    ? Math.max(0, completedForecast.expiresAt - currentTime)
    : completedForecast
      ? 0
      : activeForecast || isStarting
        ? Math.min(
            900_000,
            Math.max(
              0,
              entry.expiresAt -
                (activeForecast ? Math.max(currentTime, activeForecast.createdAt) : currentTime),
            ),
          )
        : hasEndPreview && previewRemaining !== null
          ? Math.min(900_000, Math.max(0, previewRemaining))
          : 900_000;
  const phase = isIdle
    ? 'idle'
    : completedForecast
      ? 'completed'
      : isMissed
        ? 'missed'
        : isSettling
          ? 'settling'
          : activeForecast
            ? 'running'
            : isStarting
              ? 'starting'
              : 'scheduled';

  return (
    <section className={`forecast-status ${phase}`} aria-label="Forecast timing">
      <h3 className="h6 mb-2" aria-live="polite">
        {isIdle
          ? '15-minute countdown'
          : completedForecast
            ? isWithheld
              ? 'No fixed call'
              : completedForecast.status === 'resolved'
                ? 'Result observed'
                : completedForecast.status === 'awaiting-settlement'
                  ? 'Awaiting Kalshi settlement'
                  : 'Result unobserved'
            : activeForecast
              ? isSettling
                ? 'Observing result'
                : 'Countdown running'
              : isMissed
                ? 'Scheduled start missed'
                : isStarting
                  ? 'Waiting for start data'
                  : 'Scheduled forecast'}
      </h3>
      <div className="countdown-display">
        <strong className="countdown countdown-primary" role="timer" aria-label="Time remaining">
          {isMissed || (hasEndPreview && previewRemaining === null)
            ? '—'
            : formatCountdown(remaining)}
        </strong>
        <span className="countdown-state small text-secondary">
          {isIdle
            ? hasEndPreview
              ? previewCaption
              : 'Ready to start'
            : completedForecast
              ? isWithheld && remaining > 0
                ? 'Until original end'
                : 'Window complete'
              : isMissed
                ? 'Start not captured'
                : isSettling
                  ? 'Awaiting result'
                  : activeForecast || isStarting
                    ? 'Until end time'
                    : 'Waiting for scheduled start'}
        </span>
      </div>
      {schedule?.status === 'scheduled' && !activeForecast && (
        <div className="countdown-secondary-row d-flex align-items-center justify-content-between flex-wrap gap-2 mt-2 small">
          <span className="d-inline-flex align-items-center gap-2">
            <span className="text-secondary">
              {isStarting ? 'Start available for' : 'Starts in'}
            </span>
            <strong
              className="countdown-secondary"
              role="timer"
              aria-label={isStarting ? 'Start window remaining' : 'Time until start'}
            >
              {formatCountdown(
                (isStarting ? schedule.expiresAt - 20_000 : schedule.startsAt) - currentTime,
              )}
            </strong>
          </span>
          <Button size="sm" variant="outline-secondary" onClick={onCancelSchedule}>
            Cancel scheduled start
          </Button>
        </div>
      )}
      {entry && (
        <dl className="window-summary small mt-2 mb-0">
          <div>
            <dt>Target</dt>
            <dd>{formatPrice(entry.target)}</dd>
          </div>
          <div>
            <dt>Start</dt>
            <dd>{formatDateTime(entry.startsAt ?? entry.createdAt)}</dd>
          </div>
          <div>
            <dt>End</dt>
            <dd>{formatDateTime(entry.expiresAt)}</dd>
          </div>
        </dl>
      )}
      {entry?.outcomeDefinition === KALSHI_OUTCOME_DEFINITION && (
        <span className="small text-secondary">
          Kalshi · final-minute BRTI average · ties are Yes
        </span>
      )}
      {completedForecast && (
        <p className="small mt-2 mb-0" role="status">
          {isWithheld
            ? 'No prediction was issued for this window.'
            : completedForecast.status === 'resolved'
              ? completedForecast.kalshiMarket
                ? `Kalshi settled ${completedForecast.kalshiOutcome.result === 'yes' ? 'Yes' : 'No'} · ${formatPrice(completedForecast.observedPrice)}`
                : `Observed ${completedForecast.outcome === 'equal' ? 'at' : completedForecast.outcome} target: ${formatPrice(completedForecast.observedPrice)}`
              : completedForecast.status === 'awaiting-settlement'
                ? 'The event has closed. Its official result will be retrieved automatically.'
                : 'No eligible price was observed at the deadline.'}
        </p>
      )}
      {activeForecast && !isAnalyzing && showRecordedDetails && (
        <details className="forecast-details small mt-2">
          <summary>Recorded forecast details</summary>
          <dl className="window-summary mt-2 mb-0">
            <div>
              <dt>Captured</dt>
              <dd>{formatDateTime(activeForecast.createdAt)}</dd>
            </div>
            <div>
              <dt>Yes / No</dt>
              <dd>
                {formatPercent(activeForecast.aboveProbability)} /{' '}
                {formatPercent(activeForecast.belowProbability)}
              </dd>
            </div>
          </dl>
        </details>
      )}
      {!isIdle && !completedForecast && (!activeForecast || showRecordedDetails) && (
        <p className="small text-secondary mt-2 mb-0">
          {activeForecast
            ? isAnalyzing
              ? 'Observing fresh data before issuing a fixed prediction.'
              : 'Recorded target, probabilities, and end time are fixed.'
            : isMissed
              ? 'Fresh data was unavailable before the final 20 seconds. Choose another Kalshi event.'
              : 'Keep this tab open for the start.'}
        </p>
      )}
      {isMissed && !activeForecast && (
        <Button size="sm" variant="outline-secondary" className="mt-2" onClick={onCancelSchedule}>
          Dismiss missed start
        </Button>
      )}
    </section>
  );
}
