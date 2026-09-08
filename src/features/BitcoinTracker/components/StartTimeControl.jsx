import { Button, Form } from 'react-bootstrap';
import { formatDateTime } from '../utils/format.utils';
import { formatLocalDateTime, getNextQuarterHour } from '../utils/schedule.utils';

export default function StartTimeControl({
  mode,
  value,
  onModeChange,
  onChange,
  now,
  error,
  disabled,
  startsAt,
}) {
  const isEndTime = mode === 'scheduled-end';
  const start = mode === 'now' ? now : startsAt;
  const chooseInstant = (timestamp) => {
    const rounded = Math.floor(timestamp / 1000) * 1000;
    onChange(formatLocalDateTime(rounded), rounded);
  };
  return (
    <fieldset className="start-time-controls mb-2" disabled={disabled}>
      <Form.Label htmlFor="start-mode" className="small fw-medium">
        Schedule by
      </Form.Label>
      <Form.Select
        id="start-mode"
        size="sm"
        value={mode}
        onChange={(event) => onModeChange(event.target.value)}
      >
        <option value="now">Start now</option>
        <option value="scheduled-end">End time</option>
        <option value="scheduled">Start time</option>
      </Form.Select>
      {mode !== 'now' && (
        <div className="mt-2">
          <Form.Label
            htmlFor={isEndTime ? 'scheduled-end' : 'scheduled-start'}
            className="small fw-medium"
          >
            {isEndTime ? 'Scheduled end (local time)' : 'Scheduled start (local time)'}
          </Form.Label>
          <Form.Control
            id={isEndTime ? 'scheduled-end' : 'scheduled-start'}
            size="sm"
            type="datetime-local"
            step="1"
            value={value}
            required
            onChange={(event) => onChange(event.target.value)}
            aria-invalid={Boolean(error)}
            aria-describedby="schedule-help schedule-error"
          />
          <div className="d-flex flex-wrap gap-2 mt-2">
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={() => chooseInstant(now + (isEndTime ? 900_000 : 60_000))}
            >
              {isEndTime ? 'End in 15 minutes' : 'In 1 minute'}
            </Button>
            <Button
              variant="outline-secondary"
              size="sm"
              onClick={() => chooseInstant(getNextQuarterHour(now))}
            >
              Next quarter hour
            </Button>
          </div>
          <p id="schedule-help" className="small text-secondary mt-2 mb-0">
            {isEndTime
              ? 'Start now if the window has begun. The end time stays fixed.'
              : 'Within 24 hours. Keep this tab open at the start.'}
          </p>
          <p id="schedule-error" className="small text-danger mt-1 mb-0" aria-live="polite">
            {error}
          </p>
        </div>
      )}
      <dl className="window-summary small mt-2 mb-0">
        <div>
          <dt>{isEndTime ? 'Window start' : 'Start'}</dt>
          <dd>{mode === 'now' ? 'When you select Start forecast' : formatDateTime(start)}</dd>
        </div>
        <div>
          <dt>End</dt>
          <dd>
            {mode === 'now'
              ? '15 minutes after start'
              : Number.isFinite(start)
                ? formatDateTime(start + 900_000)
                : '—'}
          </dd>
        </div>
      </dl>
    </fieldset>
  );
}
