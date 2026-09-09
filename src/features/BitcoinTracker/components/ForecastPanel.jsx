import { Button, Form, InputGroup } from 'react-bootstrap';
import Icon from './Icon';
import StartTimeControl from './StartTimeControl';
import ForecastStatus from './ForecastStatus';
import ForecastPrediction from './ForecastPrediction';
import { PRESSURE_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { formatCountdown, formatPrice, formatTime } from '../utils/format.utils';
import {
  formatLocalDateTime,
  getNextQuarterHour,
  getScheduleError,
  getEndScheduleError,
  parseScheduledStart,
} from '../utils/schedule.utils';

const WITHHELD_REASONS = {
  'insufficient-time': 'Not enough time for observation and at least one minute before the end.',
  'no-consensus': 'No direction met the signal rule before the decision window closed.',
  'market-data-unavailable': 'Fresh, uninterrupted market data was unavailable during observation.',
  'model-unavailable': 'The saved model version is unavailable; no replacement call was issued.',
  'market-conditions': 'Market stress or conflicting trade flow prevented a fixed call.',
};

function FixedPredictionStatus({ entry, progress, now, hasDifferentTarget }) {
  const isWithheld = entry.status === 'withheld';
  const usesPressure = entry.analysis?.policyVersion === PRESSURE_POLICY_VERSION;
  const observationRemaining =
    progress?.observationRemainingMs ?? Math.max(0, (entry.analysis?.earliestAt ?? now) - now);
  const isObserving = !isWithheld && observationRemaining > 0;
  const isConfirming = !isObserving && progress?.sampleCount > 0;
  const progressRemaining = isObserving
    ? observationRemaining
    : isConfirming
      ? progress.confirmationRemainingMs
      : Math.max(0, (entry.analysis?.deadline ?? now) - now);

  return (
    <section aria-label="Fixed prediction" className="fixed-prediction-status">
      <div className="forecast-result neutral">
        <span className="small text-secondary">Fixed prediction</span>
        <h3 className="result-heading mt-1 mb-1" aria-live="polite">
          {isWithheld
            ? 'No clear signal'
            : progress?.phase === 'ready'
              ? 'Recording fixed call…'
              : isObserving
                ? 'Observing market'
                : usesPressure
                  ? 'Waiting for fresh data'
                  : 'Waiting for a clear signal'}
        </h3>
        <p className="small text-secondary mb-0">
          {isWithheld
            ? WITHHELD_REASONS[entry.withholdingReason] || 'No fixed prediction was issued.'
            : progress?.reason ||
              (usesPressure
                ? 'The fixed estimate is recorded after three minutes of observation, even when the edge is small.'
                : 'Earlier policy: a direction must stay at ≥65% model probability for 60 seconds.')}
        </p>
        {!isWithheld && (
          <div className="fixed-progress d-flex justify-content-between align-items-center flex-wrap gap-1 mt-1 small">
            <span>
              {isObserving
                ? 'Minimum observation'
                : isConfirming
                  ? 'Signal confirmation'
                  : 'Decision window'}{' '}
              <strong
                className="countdown"
                role="timer"
                aria-label="Time until fixed prediction check"
              >
                {Number.isFinite(progressRemaining) ? formatCountdown(progressRemaining) : '—'}
              </strong>
            </span>
            {!usesPressure && (
              <span className="text-secondary">
                Qualifying quotes: {progress?.sampleCount ?? 0}
              </span>
            )}
          </div>
        )}
        {hasDifferentTarget && (
          <p className="small text-secondary mt-1 mb-0">Saved target {formatPrice(entry.target)}</p>
        )}
      </div>
    </section>
  );
}

export default function ForecastPanel({
  targetInput,
  onTargetChange,
  ticker,
  forecast,
  forecastDeadline,
  timingSelection,
  onTimingChange,
  activeForecast,
  recordedForecast,
  fixedProgress,
  scheduledForecast,
  now,
  onRecord,
  onNewForecast,
  isJournalReady,
  onCancelSchedule,
  isLoading,
}) {
  const { mode: scheduleMode, value: selectedTime, timestamp } = timingSelection;
  const isEndTime = scheduleMode === 'scheduled-end';
  // Keep the exact instant from shortcuts across a repeated local hour at DST fallback.
  const selectedAt = timestamp ?? parseScheduledStart(selectedTime);
  const startsAt = isEndTime ? selectedAt - 900_000 : selectedAt;
  const changeSelectedTime = (value, timestamp = null) =>
    onTimingChange({ mode: scheduleMode, value, timestamp });
  const scheduleError = isEndTime
    ? getEndScheduleError(selectedAt, now)
    : scheduleMode === 'scheduled'
      ? getScheduleError(startsAt, now)
      : null;
  const hasActiveSchedule = scheduledForecast?.status === 'scheduled';
  const startsImmediately = scheduleMode === 'now' || (isEndTime && startsAt <= now);
  const isAnalyzing = recordedForecast?.status === 'analyzing';
  const isWithheld = recordedForecast?.status === 'withheld';
  const isCompleted =
    recordedForecast && !['analyzing', 'pending'].includes(recordedForecast.status);
  const hasWindowEnded = recordedForecast && now >= recordedForecast.expiresAt;
  const liveDescription = forecast.available
    ? recordedForecast
      ? null
      : 'Preview updates until you start the forecast.'
    : forecastDeadline !== null && !Number.isFinite(forecastDeadline)
      ? 'Choose a valid end time.'
      : forecastDeadline !== null && forecastDeadline <= now
        ? recordedForecast
          ? null
          : 'The selected end time has passed.'
        : isLoading
          ? 'Waiting for fresh market data.'
          : forecast.reason || 'Waiting for fresh market data.';
  const target = Number(targetInput);
  const isTargetValid =
    targetInput.trim() !== '' && Number.isFinite(target) && target > 0 && target <= 1e9;
  const savedTarget =
    recordedForecast?.target ?? (hasActiveSchedule ? scheduledForecast.target : null);
  const hasDifferentTarget = savedTarget !== null && (!isTargetValid || target !== savedTarget);
  const canRecord =
    isJournalReady &&
    !activeForecast &&
    !recordedForecast &&
    !hasActiveSchedule &&
    isTargetValid &&
    !scheduleError &&
    (!startsImmediately || forecast.available);
  const changeScheduleMode = (mode) => {
    const hasRemainingWindow = Number.isFinite(startsAt) && startsAt + 900_000 > now;
    if (mode === 'now') {
      onTimingChange({
        mode,
        value: hasRemainingWindow ? formatLocalDateTime(startsAt) : '',
        timestamp: hasRemainingWindow ? startsAt : null,
      });
      return;
    }
    const nextStart = hasRemainingWindow
      ? startsAt
      : mode === 'scheduled-end'
        ? getNextQuarterHour(now) - 900_000
        : getNextQuarterHour(now);
    const nextSelection = mode === 'scheduled-end' ? nextStart + 900_000 : nextStart;
    onTimingChange({ mode, value: formatLocalDateTime(nextSelection), timestamp: nextSelection });
  };

  return (
    <section className="forecast-panel" aria-label="Forecast controls">
      <Form
        className="forecast-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (canRecord)
            onRecord({
              startMode: scheduleMode,
              startsAt,
              expiresAt: isEndTime ? selectedAt : undefined,
            });
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
            onCancelSchedule={onCancelSchedule}
            previewEndsAt={isEndTime ? selectedAt : undefined}
            showRecordedDetails={false}
          />
          {recordedForecast && (isAnalyzing || isWithheld) ? (
            <FixedPredictionStatus
              entry={recordedForecast}
              progress={fixedProgress}
              now={now}
              hasDifferentTarget={hasDifferentTarget}
            />
          ) : recordedForecast ? (
            <ForecastPrediction
              forecast={{ ...recordedForecast, available: true }}
              label="Fixed prediction"
              caption={`Captured ${formatTime(recordedForecast.createdAt)}`}
              description={
                hasDifferentTarget
                  ? `Recorded target ${formatPrice(recordedForecast.target)}`
                  : null
              }
            />
          ) : null}
          <ForecastPrediction
            forecast={forecast}
            label="Live estimate"
            caption={
              hasWindowEnded
                ? null
                : forecastDeadline === null || forecastDeadline > now + 900_000
                  ? '15 minutes from now'
                  : 'Until the end time'
            }
            description={
              forecast.available && hasDifferentTarget
                ? `Preview target ${formatPrice(target)}`
                : hasActiveSchedule && forecast.available
                  ? 'Observation begins at the scheduled start; the fixed call comes later.'
                  : liveDescription
            }
            unavailableLabel={
              hasWindowEnded ? 'Window ended' : isLoading ? 'Connecting…' : 'Estimate paused'
            }
            compact={Boolean(recordedForecast)}
          />
          <p className="small text-secondary mt-2 mb-0">Model estimates · not yet validated</p>
        </section>
        <section className="forecast-setup dashboard-panel" aria-labelledby="forecast-heading">
          <div className="d-flex justify-content-between align-items-center mb-2">
            <h2 id="forecast-heading" className="section-title mb-0">
              Forecast setup
            </h2>
            <span className="time-chip">
              <Icon name="clock" size={14} /> 15m window
            </span>
          </div>
          <div className="target-control">
            <Form.Label htmlFor="target-price" className="small fw-medium">
              Target price
            </Form.Label>
            <InputGroup className="target-input">
              <InputGroup.Text>$</InputGroup.Text>
              <Form.Control
                id="target-price"
                type="number"
                inputMode="decimal"
                min="0.01"
                max="1000000000"
                step="0.01"
                required
                value={targetInput}
                placeholder="Enter a USD price"
                onChange={(event) => onTargetChange(event.target.value)}
                aria-describedby="target-help"
                aria-invalid={targetInput !== '' && !isTargetValid}
              />
              <InputGroup.Text>USD</InputGroup.Text>
            </InputGroup>
            <div className="d-flex align-items-center justify-content-between gap-2 mt-1 mb-2">
              <span id="target-help" className="small text-secondary">
                {isTargetValid && ticker
                  ? `${((target / ticker.price - 1) * 100).toFixed(2)}% from current price`
                  : 'Enter a positive price in USD'}
              </span>
              <Button
                variant="link"
                size="sm"
                className="p-0 flex-shrink-0"
                disabled={!ticker}
                onClick={() => onTargetChange(ticker.price.toFixed(2))}
              >
                Use current
              </Button>
            </div>
          </div>
          {!recordedForecast && !activeForecast && !hasActiveSchedule && (
            <StartTimeControl
              mode={scheduleMode}
              value={selectedTime}
              onModeChange={changeScheduleMode}
              onChange={changeSelectedTime}
              startsAt={startsAt}
              now={now}
              error={scheduleError}
              disabled={!isJournalReady}
            />
          )}
          <div className="forecast-action mt-auto">
            <Button
              type={isCompleted ? 'button' : 'submit'}
              className="w-100 track-button d-flex justify-content-center align-items-center gap-2"
              disabled={!isCompleted && !canRecord}
              onClick={
                isCompleted
                  ? (event) => {
                      event.preventDefault();
                      onNewForecast();
                    }
                  : undefined
              }
            >
              {isCompleted
                ? 'New forecast'
                : activeForecast
                  ? isAnalyzing
                    ? 'Observing market'
                    : 'Forecast in progress'
                  : hasActiveSchedule
                    ? 'Start scheduled'
                    : startsImmediately
                      ? 'Start forecast'
                      : 'Schedule forecast'}{' '}
              <Icon name={activeForecast || hasActiveSchedule ? 'clock' : 'arrow'} />
            </Button>
            <p className="small text-secondary mt-2 mb-0">
              {isCompleted
                ? 'Edit the target for your next forecast. The original result stays saved.'
                : activeForecast
                  ? isAnalyzing
                    ? 'Observing the saved target. Edits update Live; the end time stays fixed.'
                    : 'Target edits update Live. Fixed keeps its recorded target and end.'
                  : isEndTime && startsImmediately
                    ? 'Records an estimate after three minutes, before the selected end.'
                    : hasActiveSchedule || scheduleMode !== 'now'
                      ? 'Saves the target now; observation begins at the scheduled start.'
                      : 'Starts the countdown; records the fixed estimate after three minutes with fresh data.'}
            </p>
          </div>
        </section>
      </Form>
    </section>
  );
}
