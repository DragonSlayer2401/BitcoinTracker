import { Button } from 'react-bootstrap';
import { formatCountdown, formatDateTime, formatPercent, formatPrice } from '../utils/format.utils';

export default function ForecastStatus({
  activeForecast,
  schedule,
  now,
  onCancelSchedule,
  previewEndsAt,
}) {
  const isIdle = !activeForecast && !schedule;
  const isMissed = schedule?.status === 'missed';
  const isStarting = schedule?.status === 'scheduled' && now >= schedule.startsAt;
  const isSettling = activeForecast && now >= activeForecast.expiresAt;
  const entry = activeForecast || schedule;
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
  const remaining =
    activeForecast || isStarting
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
            <span className="text-secondary">{isStarting ? 'Start data grace' : 'Starts in'}</span>
            <strong
              className="countdown-secondary"
              role="timer"
              aria-label={isStarting ? 'Start window remaining' : 'Time until start'}
            >
              {formatCountdown(
                (isStarting ? schedule.startsAt + 15_000 : schedule.startsAt) - currentTime,
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
      {activeForecast && (
        <details className="forecast-details small mt-2">
          <summary>Recorded forecast details</summary>
          <dl className="window-summary mt-2 mb-0">
            <div>
              <dt>Captured</dt>
              <dd>{formatDateTime(activeForecast.createdAt)}</dd>
            </div>
            <div>
              <dt>Above / below</dt>
              <dd>
                {formatPercent(activeForecast.aboveProbability)} /{' '}
                {formatPercent(activeForecast.belowProbability)}
              </dd>
            </div>
          </dl>
        </details>
      )}
      {!isIdle && (
        <p className="small text-secondary mt-2 mb-0">
          {activeForecast
            ? 'Recorded target, probabilities, and end time are fixed.'
            : isMissed
              ? 'No valid start was captured within 15 seconds. Select a new start time.'
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
