import { Form } from 'react-bootstrap';
import Select from 'react-select';
import { KALSHI_CHECKPOINT_MINUTES } from '../utils/fixedPrediction.utils';
import './KalshiEventControl.scss';

const options = KALSHI_CHECKPOINT_MINUTES.map((minutes) => ({
  value: minutes,
  label: `${minutes} min left`,
}));
const classNames = {
  control: ({ isFocused, isDisabled }) =>
    'schedule-select-control' +
    (isFocused ? ' schedule-select-focused' : '') +
    (isDisabled ? ' schedule-select-disabled' : ''),
  valueContainer: () => 'schedule-select-value checkpoint-select-values',
  dropdownIndicator: () => 'schedule-select-arrow',
  multiValue: () => 'checkpoint-select-chip',
  multiValueLabel: () => 'checkpoint-select-chip-label',
  multiValueRemove: () => 'checkpoint-select-chip-remove',
  menuPortal: () => 'schedule-select-menu-portal',
  menu: () => 'schedule-select-menu',
  menuList: () => 'schedule-select-options',
  option: ({ isFocused, isSelected }) =>
    'schedule-select-option' +
    (isFocused ? ' schedule-option-focused' : '') +
    (isSelected ? ' schedule-option-selected' : ''),
};

export default function ForecastModeControl({
  autoEnabled,
  onAutoEnabledChange,
  checkpointMinutes,
  onCheckpointMinutesChange,
  hasRecordedEvent,
  isJournalOwner = true,
  disabled = false,
  preferencesWarning,
}) {
  const isDisabled = disabled || !isJournalOwner;
  return (
    <div className="forecast-mode-control mb-2">
      <div className="d-flex justify-content-between align-items-center gap-2 mb-1">
        <Form.Label htmlFor="fixed-checkpoints" className="small fw-medium mb-0">
          Fixed checkpoints
        </Form.Label>
        <Form.Check
          id="automatic-forecasts"
          type="switch"
          label="Auto record"
          className="small mb-0"
          checked={autoEnabled}
          onChange={(event) => onAutoEnabledChange?.(event.target.checked)}
          disabled={isDisabled}
          aria-describedby="fixed-checkpoint-help"
        />
      </div>
      <Select
        inputId="fixed-checkpoints"
        instanceId="fixed-checkpoints"
        unstyled
        isMulti
        isClearable={false}
        isSearchable={false}
        closeMenuOnSelect={false}
        className="schedule-select"
        classNames={classNames}
        options={options}
        value={options.filter((option) => checkpointMinutes.includes(option.value))}
        onChange={(selected) => {
          if (selected.length)
            onCheckpointMinutesChange?.(
              options
                .filter((option) => selected.some((item) => item.value === option.value))
                .map((option) => option.value),
            );
        }}
        isDisabled={isDisabled}
        aria-describedby="fixed-checkpoint-help fixed-checkpoint-selection-help"
        placeholder="Choose capture times…"
        menuPlacement="auto"
        menuPosition="fixed"
        menuPortalTarget={typeof document === 'undefined' ? undefined : document.body}
        menuShouldScrollIntoView={false}
        maxMenuHeight={180}
      />
      <span id="fixed-checkpoint-selection-help" className="visually-hidden">
        Choose at least one checkpoint. Times are minutes remaining before the Kalshi event closes.
      </span>
      <p id="fixed-checkpoint-help" className="small text-secondary mt-1 mb-0">
        {!isJournalOwner
          ? 'Another tab manages recording. Controls are read-only here.'
          : hasRecordedEvent
            ? 'Changes apply to the next event.'
            : 'One fixed call at each selected time remaining.'}
        {autoEnabled && isJournalOwner && ' Keep this tab open for Auto.'}
      </p>
      {preferencesWarning && (
        <p className="small text-warning mt-1 mb-0" role="alert">
          {preferencesWarning}
        </p>
      )}
    </div>
  );
}
