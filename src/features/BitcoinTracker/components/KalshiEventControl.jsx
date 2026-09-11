import { Form } from 'react-bootstrap';
import Select from 'react-select';
import { formatTime } from '../utils/format.utils';
import './KalshiEventControl.scss';

const scheduleClassNames = {
  control: ({ isFocused, isDisabled }) =>
    'schedule-select-control' +
    (isFocused ? ' schedule-select-focused' : '') +
    (isDisabled ? ' schedule-select-disabled' : ''),
  valueContainer: () => 'schedule-select-value',
  singleValue: () => 'schedule-select-selection',
  dropdownIndicator: () => 'schedule-select-arrow',
  menuPortal: () => 'schedule-select-menu-portal',
  menu: () => 'schedule-select-menu',
  menuList: () => 'schedule-select-options',
  option: ({ isFocused, isSelected }) =>
    'schedule-select-option' +
    (isFocused ? ' schedule-option-focused' : '') +
    (isSelected ? ' schedule-option-selected' : ''),
};

export default function KalshiEventControl({ markets, market, onChange, now, error, disabled }) {
  const options = markets
    .filter((item) => item.expiresAt > now)
    .map((item) => ({
      value: item.ticker,
      label: `${formatTime(item.startsAt)} – ${formatTime(item.expiresAt)}${item.target === null ? ' · target pending' : ''}`,
    }));
  return (
    <div className="mb-2">
      <div className="d-flex justify-content-between align-items-center gap-2 mb-1">
        <Form.Label htmlFor="kalshi-event" className="small fw-medium mb-0">
          Kalshi event
        </Form.Label>
      </div>
      <Select
        inputId="kalshi-event"
        instanceId="kalshi-event"
        unstyled
        className="schedule-select"
        classNames={scheduleClassNames}
        options={options}
        value={
          options.find((option) => option.value === market?.ticker) ??
          (market
            ? {
                value: market.ticker,
                label: `${formatTime(market.startsAt)} – ${formatTime(market.expiresAt)}${market.expiresAt <= now ? ' · closed' : ''}`,
              }
            : null)
        }
        onChange={(option) => onChange(option?.value ?? null)}
        isSearchable={false}
        isDisabled={disabled}
        placeholder={error ? 'Kalshi unavailable' : 'Loading Bitcoin events…'}
        menuPlacement="auto"
        menuPosition="fixed"
        menuPortalTarget={typeof document === 'undefined' ? undefined : document.body}
        menuShouldScrollIntoView={false}
        maxMenuHeight={180}
      />
      <p className="small text-secondary mt-1 mb-0">
        {error
          ? 'Could not refresh Kalshi events. Retrying automatically.'
          : market?.target == null
            ? 'The official target is published when this event starts.'
            : 'Yes: final-minute BRTI average ≥ target. A tie counts as Yes.'}
      </p>
      {market?.url && (
        <a className="small" href={market.url} target="_blank" rel="noreferrer">
          View contract and rules ↗
        </a>
      )}
    </div>
  );
}
