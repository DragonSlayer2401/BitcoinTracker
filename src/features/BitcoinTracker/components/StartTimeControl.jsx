import { Button, Form } from 'react-bootstrap';
import Select from 'react-select';
import { formatDateTime } from '../utils/format.utils';
import { formatLocalDateTime, getNextQuarterHour } from '../utils/schedule.utils';
import './StartTimeControl.scss';

const scheduleOptions = [
  { value: 'now', label: 'Start now' },
  { value: 'scheduled-end', label: 'End time' },
  { value: 'scheduled', label: 'Start time' },
];

const scheduleClassNames = {
  control: ({ isFocused, isDisabled }) =>
    `schedule-select-control${isFocused ? ' schedule-select-focused' : ''}${isDisabled ? ' schedule-select-disabled' : ''}`,
  valueContainer: () => 'schedule-select-value',
  singleValue: () => 'schedule-select-selection',
  dropdownIndicator: () => 'schedule-select-arrow',
  menuPortal: () => 'schedule-select-menu-portal',
  menu: () => 'schedule-select-menu',
  menuList: () => 'schedule-select-options',
  option: ({ isFocused, isSelected }) =>
    `schedule-select-option${isFocused ? ' schedule-option-focused' : ''}${isSelected ? ' schedule-option-selected' : ''}`,
};

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
      <Select
        inputId="start-mode"
        instanceId="start-mode"
        className="schedule-select"
        classNames={scheduleClassNames}
        unstyled
        options={scheduleOptions}
        value={scheduleOptions.find((option) => option.value === mode)}
        onChange={(option) => onModeChange(option.value)}
        isSearchable={false}
        isClearable={false}
        isDisabled={disabled}
        blurInputOnSelect={false}
        menuPlacement="auto"
        menuPosition="fixed"
        menuPortalTarget={typeof document === 'undefined' ? undefined : document.body}
        menuShouldScrollIntoView={false}
        minMenuHeight={110}
        maxMenuHeight={180}
      />
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
