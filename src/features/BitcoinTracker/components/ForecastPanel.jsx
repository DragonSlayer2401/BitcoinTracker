import { Button, Form, InputGroup } from 'react-bootstrap';
import Icon from './Icon';
import StartTimeControl from './StartTimeControl';
import ForecastStatus from './ForecastStatus';
import ForecastPrediction from './ForecastPrediction';
import { formatPrice, formatTime } from '../utils/format.utils';
import {
  formatLocalDateTime,
  getNextQuarterHour,
  getScheduleError,
  getEndScheduleError,
  parseScheduledStart,
} from '../utils/schedule.utils';

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
  const isCompleted = recordedForecast && recordedForecast.status !== 'pending';
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
          {recordedForecast && (
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
          )}
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
                  ? 'Fixed prediction will be captured at the scheduled start.'
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
                  ? 'Forecast in progress'
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
                  ? 'Target edits update Live. Fixed keeps its recorded target and end.'
                  : isEndTime && startsImmediately
                    ? 'Records this estimate and counts down to the selected end.'
                    : hasActiveSchedule || scheduleMode !== 'now'
                      ? 'The target is saved now; the estimate is captured at the start.'
                      : 'Locks the prediction now and starts the 15-minute countdown.'}
            </p>
          </div>
        </section>
      </Form>
    </section>
  );
}
