import { Button, Form, InputGroup } from 'react-bootstrap';
import Icon from './Icon';
import StartTimeControl from './StartTimeControl';
import ForecastStatus from './ForecastStatus';
import { formatPercent, formatPrice } from '../utils/format.utils';
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
  scheduledForecast,
  now,
  onRecord,
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
  const directionLabel =
    forecast.direction === 'above'
      ? 'Likely above'
      : forecast.direction === 'below'
        ? 'Likely below'
        : 'Too close to call';
  const target = Number(targetInput);
  const isTargetValid =
    targetInput.trim() !== '' && Number.isFinite(target) && target > 0 && target <= 1e9;
  const canRecord =
    isJournalReady &&
    !activeForecast &&
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
            Countdown & estimate
          </h2>
          <ForecastStatus
            activeForecast={activeForecast}
            schedule={scheduledForecast}
            now={now}
            onCancelSchedule={onCancelSchedule}
            previewEndsAt={isEndTime ? selectedAt : undefined}
          />
          <div
            className={`forecast-result ${forecast.available ? forecast.direction : 'unavailable'}`}
          >
            <span className="small text-secondary">
              {forecastDeadline === null || forecastDeadline > now + 900_000
                ? 'Live preview · 15 minutes from now'
                : 'Live preview · until the end time'}
            </span>
            <h3 className="result-heading mt-2 mb-1">
              {forecast.available && (
                <Icon
                  name={
                    forecast.direction === 'below'
                      ? 'down'
                      : forecast.direction === 'above'
                        ? 'up'
                        : 'activity'
                  }
                  size={28}
                />
              )}
              {forecast.available ? directionLabel : isLoading ? 'Connecting…' : 'Estimate paused'}
            </h3>
            <p className="small text-secondary mb-0">
              {forecast.available
                ? 'Model estimate · not yet validated'
                : forecastDeadline !== null && !Number.isFinite(forecastDeadline)
                  ? 'Choose a valid end time.'
                  : forecastDeadline !== null && forecastDeadline <= now
                    ? 'The selected end time has passed.'
                    : isLoading
                      ? 'Waiting for fresh market data.'
                      : forecast.reason || 'Waiting for fresh market data.'}
            </p>
          </div>
          <div className="probability-labels d-flex justify-content-between mt-2 mb-2">
            <div>
              <span className="small text-secondary">Above target</span>
              <strong className="ms-2">{formatPercent(forecast.aboveProbability)}</strong>
            </div>
            <div className="text-end">
              <span className="small text-secondary">Below target</span>
              <strong className="ms-2">{formatPercent(forecast.belowProbability)}</strong>
            </div>
          </div>
          <div
            className={`probability-track ${forecast.available ? '' : 'unavailable'}`}
            role="img"
            aria-label={`Above target ${formatPercent(forecast.aboveProbability)}, below target ${formatPercent(forecast.belowProbability)}`}
          >
            <div
              className="probability-above"
              style={{ width: forecast.available ? `${forecast.aboveProbability * 100}%` : '0%' }}
            />
          </div>
          {forecast.available && (
            <p className="small text-secondary mt-2 mb-0">
              Model 80% range: {formatPrice(forecast.lowerBound)}–{formatPrice(forecast.upperBound)}
            </p>
          )}
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
          {!activeForecast && !hasActiveSchedule && (
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
              type="submit"
              className="w-100 track-button d-flex justify-content-center align-items-center gap-2"
              disabled={!canRecord}
            >
              {activeForecast
                ? 'Forecast in progress'
                : hasActiveSchedule
                  ? 'Start scheduled'
                  : startsImmediately
                    ? 'Start forecast'
                    : 'Schedule forecast'}{' '}
              <Icon name={activeForecast || hasActiveSchedule ? 'clock' : 'arrow'} />
            </Button>
            <p className="small text-secondary mt-2 mb-0">
              {activeForecast
                ? 'Editing the preview does not change the running forecast.'
                : isEndTime && startsImmediately
                  ? 'Records this estimate and counts down to the selected end.'
                  : hasActiveSchedule || scheduleMode !== 'now'
                    ? 'The target is saved now; the estimate is captured at the start.'
                    : 'Records this estimate and starts the 15-minute countdown.'}
            </p>
          </div>
        </section>
      </Form>
    </section>
  );
}
