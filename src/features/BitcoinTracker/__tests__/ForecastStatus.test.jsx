import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ForecastStatus from '../components/ForecastStatus';
import { formatDateTime, formatPrice } from '../utils/format.utils';

const NOW = Date.UTC(2026, 8, 8, 12, 0, 0);
const DURATION = 15 * 60_000;
const makeForecast = (overrides = {}) => ({
  id: 'forecast-1',
  createdAt: NOW,
  expiresAt: NOW + DURATION,
  target: 71_000,
  aboveProbability: 0.7,
  belowProbability: 0.3,
  status: 'pending',
  ...overrides,
});
const makeSchedule = (overrides = {}) => ({
  id: 'schedule-1',
  createdAt: NOW,
  startsAt: NOW + 5 * 60_000,
  expiresAt: NOW + 20 * 60_000,
  target: 72_000,
  status: 'scheduled',
  ...overrides,
});

describe('forecast countdown display', () => {
  test('shows the full 15-minute countdown before a forecast is configured', () => {
    render(<ForecastStatus activeForecast={null} schedule={null} now={NOW} />);

    const timing = within(screen.getByRole('region', { name: 'Forecast timing' }));
    expect(timing.getByRole('heading', { name: '15-minute countdown' })).toBeVisible();
    expect(timing.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(timing.getByText('Ready to start')).toBeVisible();
    expect(timing.queryByRole('button')).not.toBeInTheDocument();
    expect(timing.queryByText('Target')).not.toBeInTheDocument();
  });

  test('keeps the idle display valid before the client clock initializes', () => {
    render(<ForecastStatus now={null} />);

    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
  });

  test('previews the actual remaining time until an end selected within the current window', () => {
    const previewEndsAt = NOW + 12 * 60_000;
    const { rerender } = render(<ForecastStatus now={NOW} previewEndsAt={previewEndsAt} />);

    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^12:00$/);
    expect(screen.getByText('Until selected end')).toBeVisible();
    expect(screen.queryByText('Countdown running')).not.toBeInTheDocument();

    rerender(<ForecastStatus now={NOW + 1000} previewEndsAt={previewEndsAt} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^11:59$/);
  });

  test('parks a distant end preview until the 15-minute window is reached', () => {
    const previewEndsAt = NOW + 20 * 60_000;
    const { rerender } = render(<ForecastStatus now={NOW} previewEndsAt={previewEndsAt} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(screen.getByText('Waiting for 15-minute window')).toBeVisible();

    rerender(<ForecastStatus now={NOW + 5 * 60_000} previewEndsAt={previewEndsAt} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(screen.getByText('Until selected end')).toBeVisible();
    rerender(<ForecastStatus now={NOW + 6 * 60_000} previewEndsAt={previewEndsAt} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:00$/);
  });

  test.each([0, -1000])(
    'shows a passed end honestly without resetting to fifteen minutes: %ims',
    (offset) => {
      render(<ForecastStatus now={NOW} previewEndsAt={NOW + offset} />);

      expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^00:00$/);
      expect(screen.getByText('Selected end has passed')).toBeVisible();
    },
  );

  test.each([NaN, Infinity, null, '2026-09-08T12:12:00', NOW + 0.5])(
    'does not invent a timer for an invalid end: %s',
    (previewEndsAt) => {
      render(<ForecastStatus now={NOW} previewEndsAt={previewEndsAt} />);
      expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^—$/);
      expect(screen.getByText('Choose a valid end time')).toBeVisible();
    },
  );

  test('waits for a current clock before calculating an end preview', () => {
    render(<ForecastStatus now={null} previewEndsAt={NOW + 12 * 60_000} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^—$/);
    expect(screen.getByText('Waiting for current time')).toBeVisible();
  });

  test('an active joined window preserves its chosen end while the draft end changes', () => {
    const activeForecast = makeForecast({
      timingMode: 'end',
      startsAt: NOW - 3 * 60_000,
      expiresAt: NOW + 12 * 60_000,
    });
    const { rerender } = render(
      <ForecastStatus activeForecast={activeForecast} now={NOW} previewEndsAt={NOW + 60_000} />,
    );
    expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^12:00$/);
    expect(screen.getByText('Until end time')).toBeVisible();

    rerender(
      <ForecastStatus activeForecast={activeForecast} now={NOW + 1000} previewEndsAt={NaN} />,
    );
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^11:59$/);
    expect(screen.getByText(formatDateTime(activeForecast.expiresAt))).toBeVisible();
  });

  test('parks the 15-minute timer while a separate countdown tracks the scheduled start', () => {
    const schedule = makeSchedule();
    const { rerender } = render(<ForecastStatus schedule={schedule} now={NOW} />);

    expect(screen.getByRole('heading', { name: 'Scheduled forecast' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(screen.getByText('Starts in')).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time until start' })).toHaveTextContent(/^05:00$/);
    expect(screen.getByText(formatPrice(schedule.target))).toBeVisible();
    expect(screen.getByText(formatDateTime(schedule.startsAt))).toBeVisible();
    expect(screen.getByText(formatDateTime(schedule.expiresAt))).toBeVisible();

    rerender(<ForecastStatus schedule={schedule} now={NOW + 30_000} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(screen.getByRole('timer', { name: 'Time until start' })).toHaveTextContent(/^04:30$/);
  });

  test('allows a scheduled start to be cancelled from the countdown block', async () => {
    const user = userEvent.setup();
    const onCancelSchedule = jest.fn();
    render(
      <ForecastStatus schedule={makeSchedule()} now={NOW} onCancelSchedule={onCancelSchedule} />,
    );

    await user.click(screen.getByRole('button', { name: 'Cancel scheduled start' }));
    expect(onCancelSchedule).toHaveBeenCalledTimes(1);
  });

  test('counts down an active forecast while preserving its original deadline', () => {
    const forecast = makeForecast();
    const { rerender } = render(<ForecastStatus activeForecast={forecast} now={NOW} />);

    expect(screen.getByRole('heading', { name: 'Countdown running' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);

    rerender(<ForecastStatus activeForecast={forecast} now={NOW + 1000} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:59$/);
    rerender(<ForecastStatus activeForecast={forecast} now={NOW + 5 * 60_000} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^10:00$/);
    expect(screen.getByText(formatDateTime(forecast.expiresAt))).toBeVisible();
    expect(screen.queryByRole('timer', { name: 'Time until start' })).not.toBeInTheDocument();
  });

  test('does not add time when the rendered clock is behind the actual capture time', () => {
    const forecast = makeForecast({ createdAt: NOW + 999, expiresAt: NOW + 999 + DURATION });
    const { rerender } = render(<ForecastStatus activeForecast={forecast} now={NOW} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);

    const delayed = makeForecast({ startsAt: NOW, createdAt: NOW + 5000 });
    rerender(<ForecastStatus activeForecast={delayed} now={NOW} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:55$/);
  });

  test('shows the remaining fixed window and the shorter data-capture grace separately', () => {
    const schedule = makeSchedule();
    const { rerender } = render(
      <ForecastStatus schedule={schedule} now={schedule.startsAt + 5000} />,
    );

    expect(screen.getByRole('heading', { name: 'Waiting for start data' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:55$/);
    expect(screen.getByRole('timer', { name: 'Start window remaining' })).toHaveTextContent(
      /^00:10$/,
    );
    expect(screen.queryByRole('timer', { name: 'Time until start' })).not.toBeInTheDocument();

    rerender(<ForecastStatus schedule={schedule} now={schedule.startsAt + 15_000} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^14:45$/);
    expect(screen.getByRole('timer', { name: 'Start window remaining' })).toHaveTextContent(
      /^00:00$/,
    );
  });

  test.each([0, 10_000])(
    'keeps an expired forecast at zero while observing its result: %ims',
    (delay) => {
      render(<ForecastStatus activeForecast={makeForecast()} now={NOW + DURATION + delay} />);

      expect(screen.getByRole('heading', { name: 'Observing result' })).toBeVisible();
      expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^00:00$/);
      expect(screen.getByText('Awaiting result')).toBeVisible();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    },
  );

  test('shows a missed start as unavailable and allows dismissal back to the idle timer', async () => {
    const user = userEvent.setup();
    const onCancelSchedule = jest.fn();
    const schedule = makeSchedule({ status: 'missed' });
    const { rerender } = render(
      <ForecastStatus
        schedule={schedule}
        now={schedule.startsAt + 16_000}
        onCancelSchedule={onCancelSchedule}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Scheduled start missed' })).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^—$/);
    expect(screen.queryByRole('timer', { name: 'Time until start' })).not.toBeInTheDocument();
    expect(screen.getByText(formatPrice(schedule.target))).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Dismiss missed start' }));
    expect(onCancelSchedule).toHaveBeenCalledTimes(1);

    rerender(<ForecastStatus schedule={null} now={schedule.startsAt + 16_000} />);
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent(/^15:00$/);
    expect(screen.getByText('Ready to start')).toBeVisible();
  });

  test('retains locked forecast details in an accessible disclosure', async () => {
    const user = userEvent.setup();
    const forecast = makeForecast({ startsAt: NOW, createdAt: NOW + 7000 });
    render(<ForecastStatus activeForecast={forecast} now={NOW + 10_000} />);

    expect(screen.getByText(formatPrice(forecast.target))).toBeVisible();
    expect(screen.getByText(formatDateTime(forecast.startsAt))).toBeVisible();
    expect(screen.getByText('Captured')).not.toBeVisible();
    await user.click(screen.getByText('Recorded forecast details'));
    expect(screen.getByText('Captured')).toBeVisible();
    expect(screen.getByText(formatDateTime(forecast.createdAt))).toBeVisible();
    expect(screen.getByText('70.0% / 30.0%')).toBeVisible();
  });
});
