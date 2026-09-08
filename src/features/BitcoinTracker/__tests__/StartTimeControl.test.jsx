import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import StartTimeControl from '../components/StartTimeControl';
import { formatDateTime } from '../utils/format.utils';
import { formatLocalDateTime } from '../utils/schedule.utils';

const FALLBACK_NOW = Date.UTC(2026, 10, 1, 6, 59, 12, 789);
const NEXT_QUARTER_HOUR = Date.UTC(2026, 10, 1, 7, 0);

function renderControl(overrides = {}) {
  const onChange = jest.fn();
  render(
    <StartTimeControl
      mode="scheduled"
      value={formatLocalDateTime(NEXT_QUARTER_HOUR)}
      startsAt={NEXT_QUARTER_HOUR}
      endsAt={NEXT_QUARTER_HOUR + 15 * 60_000}
      now={FALLBACK_NOW}
      onModeChange={jest.fn()}
      onChange={onChange}
      error={null}
      disabled={false}
      {...overrides}
    />,
  );
  return { onChange };
}

afterEach(cleanup);

describe('start time shortcuts', () => {
  test('preserves the next quarter-hour instant across the repeated Chicago fallback hour', () => {
    const { onChange } = renderControl();

    fireEvent.click(screen.getByRole('button', { name: 'Next quarter hour' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(
      formatLocalDateTime(NEXT_QUARTER_HOUR),
      NEXT_QUARTER_HOUR,
    );
    expect(onChange.mock.calls[0][1]).toBeGreaterThan(FALLBACK_NOW);
  });

  test('preserves seconds and removes milliseconds for the one-minute shortcut', () => {
    const { onChange } = renderControl();
    const expectedStart = Date.UTC(2026, 10, 1, 7, 0, 12);

    fireEvent.click(screen.getByRole('button', { name: 'In 1 minute' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(formatLocalDateTime(expectedStart), expectedStart);
    expect(onChange.mock.calls[0][1]).toBeGreaterThan(FALLBACK_NOW);
  });

  test('uses the supplied instant for start and end summaries when local input is ambiguous', () => {
    renderControl({ value: '2026-11-01T01:00:00', startsAt: NEXT_QUARTER_HOUR });

    expect(screen.getByText(formatDateTime(NEXT_QUARTER_HOUR))).toBeInTheDocument();
    expect(screen.getByText(formatDateTime(NEXT_QUARTER_HOUR + 15 * 60_000))).toBeInTheDocument();
    expect(screen.queryByText(formatDateTime(NEXT_QUARTER_HOUR - 60 * 60_000))).toBeNull();
  });

  test('sends manual local-time edits without retaining a shortcut timestamp', () => {
    const { onChange } = renderControl();
    const nextValue = '2026-11-01T01:05';

    fireEvent.change(screen.getByLabelText('Scheduled start (local time)'), {
      target: { value: nextValue },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(nextValue);
  });
});

describe('end time shortcuts', () => {
  test('chooses an end fifteen minutes away with an exact timestamp and whole seconds', () => {
    const { onChange } = renderControl({ mode: 'scheduled-end' });
    const expectedEnd = Date.UTC(2026, 10, 1, 7, 14, 12);

    fireEvent.click(screen.getByRole('button', { name: 'End in 15 minutes' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(formatLocalDateTime(expectedEnd), expectedEnd);
    expect(expectedEnd).toBeGreaterThan(FALLBACK_NOW);
  });

  test('chooses the next quarter hour even when less than fifteen minutes remain', () => {
    const { onChange } = renderControl({ mode: 'scheduled-end' });
    const expectedEnd = Date.UTC(2026, 10, 1, 7, 0);

    fireEvent.click(screen.getByRole('button', { name: 'Next quarter hour' }));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(formatLocalDateTime(expectedEnd), expectedEnd);
    expect(expectedEnd).toBeGreaterThan(FALLBACK_NOW);
    expect(expectedEnd - FALLBACK_NOW).toBeLessThan(15 * 60_000);
  });

  test('chooses the following quarter hour when the current time is already on one', () => {
    const now = Date.UTC(2026, 10, 1, 7, 0);
    const { onChange } = renderControl({ mode: 'scheduled-end', now });
    const expectedEnd = Date.UTC(2026, 10, 1, 7, 15);

    fireEvent.click(screen.getByRole('button', { name: 'Next quarter hour' }));

    expect(onChange).toHaveBeenCalledWith(formatLocalDateTime(expectedEnd), expectedEnd);
  });

  test('sends a manual end edit without retaining the shortcut instant', () => {
    const { onChange } = renderControl({ mode: 'scheduled-end' });
    const value = '2026-11-01T01:20';

    fireEvent.change(screen.getByLabelText('Scheduled end (local time)'), {
      target: { value },
    });

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(value);
  });
});
