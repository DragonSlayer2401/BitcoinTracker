import { Button, Form, InputGroup, Table } from 'react-bootstrap';
import Icon from './Icon';
import ForecastStatus from './ForecastStatus';
import ForecastPrediction from './ForecastPrediction';
import KalshiEventControl from './KalshiEventControl';
import ForecastModeControl from './ForecastModeControl';
import { formatCountdown, formatPercent, formatPrice, formatTime } from '../utils/format.utils';

const WITHHELD_REASONS = {
  'insufficient-time': 'Not enough time for observation before this Kalshi event closes.',
  'market-data-unavailable': 'Fresh, uninterrupted market data was unavailable during observation.',
  'model-unavailable': 'The saved model version is unavailable; no replacement call was issued.',
};

const isMissedCheckpoint = (entry) =>
  Number.isFinite(entry.checkpointMinutes) && entry.withholdingReason === 'insufficient-time';
const getWithheldReason = (entry) =>
  isMissedCheckpoint(entry)
    ? 'The selected checkpoint passed before a fixed call could be captured.'
    : WITHHELD_REASONS[entry.withholdingReason] || 'No fixed prediction was issued.';

function FixedPredictionStatus({ entry, progress, now, hasDifferentTarget }) {
  const isWithheld = entry.status === 'withheld';
  const observationRemaining =
    progress?.observationRemainingMs ?? Math.max(0, (entry.analysis?.earliestAt ?? now) - now);
  const isObserving = !isWithheld && observationRemaining > 0;
  const progressRemaining = isObserving
    ? observationRemaining
    : Math.max(0, (entry.analysis?.deadline ?? now) - now);

  return (
    <section aria-label="Fixed prediction" className="fixed-prediction-status">
      <div className="forecast-result neutral">
        <span className="small text-secondary">Fixed prediction</span>
        <h3 className="result-heading mt-1 mb-1" aria-live="polite">
          {isWithheld
            ? isMissedCheckpoint(entry)
              ? 'Checkpoint missed'
              : 'No fixed call'
            : progress?.phase === 'ready'
              ? 'Recording fixed call…'
              : isObserving
                ? 'Observing market'
                : 'Waiting for fresh data'}
        </h3>
        <p className="small text-secondary mb-0">
          {isWithheld
            ? getWithheldReason(entry)
            : progress?.reason ||
              'The fixed call is saved after observation, including a small edge. Joining late shortens the observation period.'}
        </p>
        {!isWithheld && (
          <div className="fixed-progress d-flex justify-content-between align-items-center flex-wrap gap-1 mt-1 small">
            <span>
              {isObserving ? 'Minimum observation' : 'Decision window'}{' '}
              <strong
                className="countdown"
                role="timer"
                aria-label="Time until fixed prediction check"
              >
                {Number.isFinite(progressRemaining) ? formatCountdown(progressRemaining) : '—'}
              </strong>
            </span>
          </div>
        )}
        {hasDifferentTarget && (
          <p className="small text-secondary mt-1 mb-0">Saved target {formatPrice(entry.target)}</p>
        )}
      </div>
    </section>
  );
}

function getCheckpointStatus(entry, now) {
  if (entry.status === 'withheld') return isMissedCheckpoint(entry) ? 'Missed' : 'Not captured';
  if (entry.status === 'analyzing') {
    const captureAt =
      entry.analysis?.earliestAt ?? entry.expiresAt - entry.checkpointMinutes * 60_000;
    if (now > (entry.analysis?.deadline ?? captureAt + 5000)) return 'Missed';
    return now < captureAt ? `In ${formatCountdown(captureAt - now)}` : 'Waiting for data';
  }
  if (entry.status === 'resolved')
    return typeof entry.correct === 'boolean'
      ? entry.correct
        ? 'Correct'
        : 'Incorrect'
      : `Settled ${entry.outcome === 'above' ? 'Yes' : 'No'}`;
  if (entry.status === 'unobserved') return 'Result unavailable';
  if (entry.status === 'awaiting-settlement' || now >= entry.expiresAt) return 'Awaiting result';
  return 'Saved';
}

function FixedCheckpointPredictions({ entries, now }) {
  const sorted = [...entries].sort(
    (left, right) => (right.checkpointMinutes ?? 0) - (left.checkpointMinutes ?? 0),
  );
  return (
    <section className="fixed-checkpoint-predictions" aria-labelledby="fixed-checkpoints-heading">
      <h3 id="fixed-checkpoints-heading" className="h6 small fw-semibold mb-1">
        Fixed predictions
      </h3>
      <div
        className="fixed-checkpoint-scroll"
        role="region"
        aria-label="Saved and upcoming fixed checkpoints"
        tabIndex={0}
      >
        <Table size="sm" className="fixed-checkpoint-table small mb-0">
          <caption className="visually-hidden">
            Fixed calls for the selected Kalshi event. Checkpoint times show minutes remaining
            before close. Saved probabilities do not change.
          </caption>
          <thead>
            <tr>
              <th scope="col">Checkpoint</th>
              <th scope="col">Fixed call</th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((entry) => {
              const isPublished =
                !['analyzing', 'withheld'].includes(entry.status) &&
                Number.isFinite(entry.aboveProbability);
              const probability =
                entry.direction === 'below' ? entry.belowProbability : entry.aboveProbability;
              return (
                <tr key={entry.id}>
                  <th scope="row">
                    {Number.isFinite(entry.checkpointMinutes)
                      ? `${entry.checkpointMinutes} min left`
                      : 'Original call'}
                  </th>
                  <td
                    className={
                      isPublished ? `checkpoint-call ${entry.direction}` : 'text-secondary'
                    }
                  >
                    {isPublished
                      ? entry.direction === 'neutral'
                        ? 'Neutral · 50/50'
                        : `${entry.direction === 'above' ? 'Yes' : 'No'} · ${formatPercent(probability)}`
                      : '—'}
                  </td>
                  <td
                    title={
                      entry.status === 'withheld'
                        ? getWithheldReason(entry)
                        : isPublished
                          ? `Captured ${formatTime(entry.createdAt)}`
                          : undefined
                    }
                  >
                    {getCheckpointStatus(entry, now)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      </div>
    </section>
  );
}

export default function ForecastPanel({
  targetInput,
  forecast,
  forecastDeadline,
  activeForecast,
  recordedForecast,
  fixedProgress,
  scheduledForecast,
  now,
  onRecord,
  onNewForecast,
  isJournalReady,
  isLoading,
  riskControl,
  kalshi,
  onSchedule,
  onCancelSchedule,
  autoEnabled = false,
  onAutoEnabledChange,
  checkpointMinutes = [9, 6],
  onCheckpointMinutesChange,
  eventForecasts = [],
  isPreparingForecast = false,
  isJournalOwner = true,
  preferencesWarning = null,
}) {
  const isAnalyzing = recordedForecast?.status === 'analyzing';
  const isWithheld = recordedForecast?.status === 'withheld';
  const isCompleted =
    recordedForecast && !['analyzing', 'pending'].includes(recordedForecast.status);
  const hasWindowEnded = recordedForecast && now >= recordedForecast.expiresAt;
  const isFuture = kalshi.market?.startsAt > now;
  const isScheduled = scheduledForecast?.status === 'scheduled';
  const canRecord =
    isJournalOwner &&
    isJournalReady &&
    !eventForecasts.length &&
    !activeForecast &&
    !recordedForecast &&
    !isScheduled &&
    !kalshi.error &&
    forecast.available &&
    !isFuture;
  const canSchedule =
    isJournalOwner &&
    isJournalReady &&
    !eventForecasts.length &&
    !activeForecast &&
    !recordedForecast &&
    !isScheduled &&
    isFuture &&
    kalshi.market?.rulesVerified &&
    !kalshi.error;
  const hasBenchmark = forecast.kalshi?.referenceSource === 'cf-brti';
  const description = forecast.available
    ? null
    : hasWindowEnded
      ? null
      : isLoading
        ? 'Waiting for fresh market data.'
        : forecast.reason || 'Waiting for fresh market data.';

  return (
    <section className="forecast-panel" aria-label="Forecast controls">
      <Form
        className="forecast-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canRecord) onRecord();
          else if (canSchedule) onSchedule?.();
        }}
      >
        <section className="estimate-panel dashboard-panel" aria-labelledby="estimate-heading">
          <h2 id="estimate-heading" className="section-title mb-2">
            Countdown & predictions
          </h2>
          <ForecastStatus
            activeForecast={activeForecast}
            completedForecast={isCompleted ? recordedForecast : null}
            schedule={scheduledForecast}
            now={now}
            previewEndsAt={forecastDeadline ?? undefined}
            onCancelSchedule={onCancelSchedule}
            canManageSchedule={isJournalOwner}
            showRecordedDetails={false}
          />
          {eventForecasts.length ? (
            <FixedCheckpointPredictions entries={eventForecasts} now={now} />
          ) : recordedForecast && (isAnalyzing || isWithheld) ? (
            <FixedPredictionStatus
              entry={recordedForecast}
              progress={fixedProgress}
              now={now}
              hasDifferentTarget={false}
            />
          ) : recordedForecast ? (
            <ForecastPrediction
              forecast={{ ...recordedForecast, available: true }}
              label="Fixed prediction"
              caption={'Captured ' + formatTime(recordedForecast.createdAt)}
            />
          ) : null}
          <ForecastPrediction
            forecast={forecast}
            label="Live estimate"
            caption={hasWindowEnded ? null : 'Kalshi close'}
            description={description}
            unavailableLabel={
              hasWindowEnded ? 'Window ended' : isLoading ? 'Connecting…' : 'Estimate paused'
            }
            compact={Boolean(recordedForecast || eventForecasts.length)}
          />
          <div className="d-flex justify-content-between align-items-center flex-wrap gap-1 mt-2 small text-secondary">
            {riskControl ?? 'Model estimates · not yet validated'}
          </div>
          {forecast.available && (
            <p className="small text-secondary mt-1 mb-0" role="status">
              {hasBenchmark
                ? 'BRTI benchmark connected'
                : 'Coinbase proxy · BRTI access needed for the settlement feed'}
            </p>
          )}
        </section>
        <section className="forecast-setup dashboard-panel" aria-labelledby="forecast-heading">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <h2 id="forecast-heading" className="section-title mb-0">
              Kalshi event
            </h2>
            <span className="time-chip">
              <Icon name="clock" size={14} /> 15m window
            </span>
          </div>
          <KalshiEventControl
            markets={kalshi.markets}
            market={kalshi.market}
            onChange={kalshi.onSelect}
            now={now}
            error={kalshi.error}
            disabled={Boolean(
              activeForecast ||
              (!isPreparingForecast && (recordedForecast || eventForecasts.length)) ||
              isScheduled ||
              !isJournalOwner ||
              autoEnabled,
            )}
          />
          <div className="target-control mb-2">
            <Form.Label htmlFor="target-price" className="small fw-medium">
              Kalshi target price
            </Form.Label>
            <InputGroup className="target-input">
              <InputGroup.Text>$</InputGroup.Text>
              <Form.Control
                id="target-price"
                type="number"
                value={targetInput ?? ''}
                readOnly
                placeholder="Pending official target"
                aria-describedby="target-help"
              />
              <InputGroup.Text>USD</InputGroup.Text>
            </InputGroup>
            <p id="target-help" className="visually-hidden">
              Official target · locked to this contract
            </p>
          </div>
          <ForecastModeControl
            autoEnabled={autoEnabled}
            onAutoEnabledChange={onAutoEnabledChange}
            checkpointMinutes={checkpointMinutes}
            onCheckpointMinutesChange={onCheckpointMinutesChange}
            hasRecordedEvent={Boolean(recordedForecast || eventForecasts.length || isScheduled)}
            isJournalOwner={isJournalOwner}
            disabled={!isJournalReady}
            preferencesWarning={preferencesWarning}
          />
          {forecast.available && forecast.kalshi && (
            <details className="small mb-2">
              <summary>Settlement estimate details</summary>
              <dl className="window-summary small mt-2 mb-0">
                <div>
                  <dt>Reference</dt>
                  <dd>
                    {formatPrice(forecast.kalshi.referencePrice)} ·{' '}
                    {hasBenchmark ? 'BRTI' : 'proxy'}
                  </dd>
                </div>
                <div>
                  <dt>Price history</dt>
                  <dd>
                    {forecast.kalshi.volatilitySource === 'cf-brti'
                      ? `BRTI · ${forecast.kalshi.benchmarkConditions?.features?.completedCandleCount ?? 0} complete minutes`
                      : 'Coinbase candles'}
                  </dd>
                </div>
                <div>
                  <dt>Minute volatility</dt>
                  <dd>{formatPercent(forecast.kalshi.minuteVolatility, 3)}</dd>
                </div>
                <div>
                  <dt>Final-minute readings</dt>
                  <dd>{forecast.kalshi.observedSampleCount} / 60</dd>
                </div>
                <div>
                  <dt>Missing elapsed readings</dt>
                  <dd>{forecast.kalshi.missingElapsedSampleCount}</dd>
                </div>
                <div>
                  <dt>Estimated average</dt>
                  <dd>{formatPrice(forecast.kalshi.expectedSettlementAverage)}</dd>
                </div>
                {forecast.kalshi.futureSampleCount < 60 &&
                  Number.isFinite(forecast.kalshi.requiredFutureAverage) && (
                    <div>
                      <dt>Remaining average for Yes</dt>
                      <dd>{formatPrice(forecast.kalshi.requiredFutureAverage)}</dd>
                    </div>
                  )}
              </dl>
              <p className="text-secondary mt-1 mb-0">
                Model approximation. Kalshi’s official result determines settlement.
              </p>
            </details>
          )}
          <div className="forecast-action mt-auto">
            <Button
              type={isCompleted ? 'button' : 'submit'}
              className="w-100 track-button d-flex justify-content-center align-items-center gap-2"
              disabled={!isJournalOwner || (!isCompleted && !canRecord && !canSchedule)}
              onClick={
                isCompleted
                  ? (event) => {
                      event.preventDefault();
                      if (isJournalOwner) onNewForecast();
                    }
                  : undefined
              }
            >
              {isCompleted
                ? 'New forecast'
                : activeForecast
                  ? isAnalyzing
                    ? eventForecasts.length
                      ? 'Checkpoints armed'
                      : 'Observing market'
                    : 'Forecast in progress'
                  : isScheduled
                    ? 'Start scheduled'
                    : isFuture
                      ? 'Schedule forecast'
                      : isPreparingForecast && eventForecasts.length
                        ? 'Event already recorded'
                        : 'Start forecast'}
              <Icon name={activeForecast || isScheduled ? 'clock' : 'arrow'} />
            </Button>
            <p className="small text-secondary mt-2 mb-0">
              {isScheduled
                ? 'Waiting for the official target. Fixed calls use the selected times remaining.'
                : isCompleted
                  ? 'Start another event. The original call stays saved.'
                  : isPreparingForecast && eventForecasts.length
                    ? 'Choose another Kalshi event to record new checkpoints.'
                    : 'Official target and close stay fixed. Each captured call stays saved.'}
            </p>
          </div>
        </section>
      </Form>
    </section>
  );
}
