import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ForecastPanel from '../components/ForecastPanel';

const START = Date.UTC(2026, 8, 14, 12);
const END = START + 15 * 60_000;
const NOW = START + 7 * 60_000;
const market = {
  ticker: 'KXBTC15M-UI',
  startsAt: START,
  expiresAt: END,
  target: 100_000,
  rulesVerified: true,
};
const live = {
  available: true,
  direction: 'above',
  aboveProbability: 0.65,
  belowProbability: 0.35,
  kalshi: {
    referenceSource: 'cf-brti',
    referencePrice: 100_010,
    minuteVolatility: 0.001,
    observedSampleCount: 0,
    missingElapsedSampleCount: 0,
    futureSampleCount: 60,
    expectedSettlementAverage: 100_010,
  },
};
function fixed(minutes, overrides = {}) {
  const captureAt = END - minutes * 60_000;
  return {
    id: `fixed-${minutes}`,
    checkpointMinutes: minutes,
    startsAt: START,
    expiresAt: END,
    target: market.target,
    kalshiMarket: market,
    createdAt: captureAt,
    status: 'pending',
    direction: 'above',
    aboveProbability: 0.72,
    belowProbability: 0.28,
    analysis: { earliestAt: captureAt, deadline: captureAt + 5000 },
    ...overrides,
  };
}
function props(overrides = {}) {
  return {
    targetInput: market.target,
    forecast: live,
    forecastDeadline: END,
    now: NOW,
    isJournalReady: true,
    isJournalOwner: true,
    isLoading: false,
    checkpointMinutes: [9, 6],
    autoEnabled: false,
    onAutoEnabledChange: jest.fn(),
    onCheckpointMinutesChange: jest.fn(),
    onRecord: jest.fn(),
    onSchedule: jest.fn(),
    onCancelSchedule: jest.fn(),
    onNewForecast: jest.fn(),
    kalshi: { market, markets: [market], onSelect: jest.fn(), error: null },
    ...overrides,
  };
}
const fixedTable = () =>
  screen.getByRole('table', { name: /Fixed calls for the selected Kalshi event/ });

test('Auto and multi-select checkpoints have accessible controls and send selected minutes in order', async () => {
  const user = userEvent.setup();
  const input = props();
  render(<ForecastPanel {...input} />);
  await user.click(screen.getByRole('checkbox', { name: 'Auto record' }));
  expect(input.onAutoEnabledChange).toHaveBeenCalledWith(true);
  await user.click(screen.getByRole('combobox', { name: 'Fixed checkpoints' }));
  await user.click(screen.getByRole('option', { name: '12 min left' }));
  expect(input.onCheckpointMinutesChange).toHaveBeenCalledWith([12, 9, 6]);
});

test('the final selected checkpoint cannot be removed', async () => {
  const user = userEvent.setup();
  const input = props({ checkpointMinutes: [9] });
  render(<ForecastPanel {...input} />);
  await user.click(screen.getByRole('button', { name: 'Remove 9 min left' }));
  expect(input.onCheckpointMinutesChange).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Remove 9 min left' })).toBeInTheDocument();
});

test('saved, upcoming and missed checkpoints appear alongside a separate live estimate', () => {
  const upcoming = fixed(6, {
    status: 'analyzing',
    createdAt: NOW,
    aboveProbability: null,
    belowProbability: null,
  });
  const saved = fixed(9);
  const missed = fixed(12, {
    status: 'withheld',
    aboveProbability: null,
    belowProbability: null,
    withholdingReason: 'insufficient-time',
  });
  render(
    <ForecastPanel
      {...props({
        recordedForecast: upcoming,
        activeForecast: upcoming,
        eventForecasts: [upcoming, saved, missed],
      })}
    />,
  );
  const table = fixedTable();
  expect(
    within(within(table).getByRole('row', { name: /9 min left/ })).getByText('Yes · 72.0%'),
  ).toBeInTheDocument();
  expect(
    within(within(table).getByRole('row', { name: /6 min left/ })).getByText('In 02:00'),
  ).toBeInTheDocument();
  expect(
    within(within(table).getByRole('row', { name: /12 min left/ })).getByText('Missed'),
  ).toBeInTheDocument();
  expect(screen.getByRole('region', { name: 'Live estimate' })).toHaveTextContent('65.0%');
  expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent('08:00');
  expect(screen.getByRole('button', { name: 'Checkpoints armed' })).toBeDisabled();
  expect(screen.queryByText('No clear signal')).not.toBeInTheDocument();
  expect(within(table).getByTitle(/The selected checkpoint passed/)).toHaveTextContent('Missed');
});

test('Auto and checkpoint selection also work from the keyboard', async () => {
  const user = userEvent.setup();
  const input = props();
  render(<ForecastPanel {...input} />);
  screen.getByRole('checkbox', { name: 'Auto record' }).focus();
  await user.keyboard('[Space]');
  expect(input.onAutoEnabledChange).toHaveBeenCalledWith(true);
  screen.getByRole('combobox', { name: 'Fixed checkpoints' }).focus();
  await user.keyboard('[ArrowDown][Enter]');
  expect(input.onCheckpointMinutesChange).toHaveBeenCalledWith([12, 9, 6]);
});

test('live changes preserve every already captured fixed probability', () => {
  const saved = fixed(9);
  const input = props({ recordedForecast: saved, activeForecast: saved, eventForecasts: [saved] });
  const { rerender } = render(<ForecastPanel {...input} />);
  rerender(
    <ForecastPanel
      {...input}
      forecast={{ ...live, direction: 'below', aboveProbability: 0.2, belowProbability: 0.8 }}
    />,
  );
  expect(fixedTable()).toHaveTextContent('Yes · 72.0%');
  expect(screen.getByRole('region', { name: 'Live estimate' })).toHaveTextContent('80.0%');
  expect(saved.aboveProbability).toBe(0.72);
});

test('timing changes during a recorded event are preferences for the next event', async () => {
  const user = userEvent.setup();
  const saved = fixed(9);
  const input = props({
    recordedForecast: saved,
    activeForecast: saved,
    eventForecasts: [saved],
    autoEnabled: true,
  });
  render(<ForecastPanel {...input} />);
  expect(screen.getByText(/Changes apply to the next event/)).toHaveTextContent(
    'Keep this tab open for Auto.',
  );
  await user.click(screen.getByRole('combobox', { name: 'Fixed checkpoints' }));
  await user.click(screen.getByRole('option', { name: '3 min left' }));
  expect(input.onCheckpointMinutesChange).toHaveBeenCalledWith([9, 6, 3]);
  expect(fixedTable()).toHaveTextContent('9 min left');
  expect(within(fixedTable()).queryByText('3 min left')).not.toBeInTheDocument();
  expect(input.onRecord).not.toHaveBeenCalled();
});

test('preparing another event unlocks selection while preventing a repeated current event', async () => {
  const user = userEvent.setup();
  const withheld = fixed(9, {
    status: 'withheld',
    aboveProbability: null,
    belowProbability: null,
    withholdingReason: 'market-data-unavailable',
  });
  const futureMarket = {
    ...market,
    ticker: 'KXBTC15M-NEXT',
    startsAt: END,
    expiresAt: END + 15 * 60_000,
    target: null,
  };
  const input = props({
    isPreparingForecast: true,
    activeForecast: null,
    recordedForecast: null,
    eventForecasts: [withheld],
    kalshi: { market, markets: [market, futureMarket], onSelect: jest.fn(), error: null },
  });
  render(<ForecastPanel {...input} />);
  const eventSelector = screen.getByRole('combobox', { name: 'Kalshi event' });
  expect(eventSelector).not.toBeDisabled();
  expect(screen.getByRole('button', { name: 'Event already recorded' })).toBeDisabled();
  await user.click(eventSelector);
  await user.click(screen.getByRole('option', { name: /target pending/ }));
  expect(input.kalshi.onSelect).toHaveBeenCalledWith(futureMarket.ticker);
  expect(input.onRecord).not.toHaveBeenCalled();
  expect(fixedTable()).toHaveTextContent('Not captured');
});

test('Auto keeps event selection automatic without locking next-event checkpoint preferences', async () => {
  const user = userEvent.setup();
  const input = props({ autoEnabled: true, isPreparingForecast: true });
  render(<ForecastPanel {...input} />);
  expect(screen.getByRole('combobox', { name: 'Kalshi event' })).toBeDisabled();
  expect(screen.getByRole('checkbox', { name: 'Auto record' })).not.toBeDisabled();
  const checkpoints = screen.getByRole('combobox', { name: 'Fixed checkpoints' });
  expect(checkpoints).not.toBeDisabled();
  await user.click(checkpoints);
  await user.click(screen.getByRole('option', { name: '1 min left' }));
  expect(input.onCheckpointMinutesChange).toHaveBeenCalledWith([9, 6, 1]);
  expect(input.kalshi.onSelect).not.toHaveBeenCalled();
});

test('a secondary tab cannot change recording controls or start a forecast', async () => {
  const user = userEvent.setup();
  const input = props({ isJournalOwner: false });
  render(<ForecastPanel {...input} />);
  expect(screen.getByText(/Another tab manages recording/)).toBeInTheDocument();
  expect(screen.getByRole('checkbox', { name: 'Auto record' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Fixed checkpoints' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Start forecast' }));
  expect(input.onRecord).not.toHaveBeenCalled();
});

test('a secondary tab cannot cancel an already scheduled event', async () => {
  const user = userEvent.setup();
  const input = props({
    isJournalOwner: false,
    scheduledForecast: {
      ...market,
      status: 'scheduled',
      startsAt: NOW + 60_000,
      expiresAt: NOW + 16 * 60_000,
    },
  });
  render(<ForecastPanel {...input} />);
  const cancel = screen.getByRole('button', { name: 'Cancel scheduled start' });
  expect(cancel).toBeDisabled();
  await user.click(cancel);
  expect(input.onCancelSchedule).not.toHaveBeenCalled();
});

test('neutral predictions and settled correctness remain explicit in the fixed table', () => {
  const neutral = fixed(6, { direction: 'neutral', aboveProbability: 0.5, belowProbability: 0.5 });
  const resolved = fixed(9, {
    status: 'resolved',
    direction: 'below',
    aboveProbability: 0.3,
    belowProbability: 0.7,
    correct: false,
  });
  render(
    <ForecastPanel
      {...props({
        eventForecasts: [neutral, resolved],
        recordedForecast: neutral,
        activeForecast: neutral,
      })}
    />,
  );
  expect(fixedTable()).toHaveTextContent('Neutral · 50/50');
  expect(fixedTable()).toHaveTextContent('No · 70.0%');
  expect(fixedTable()).toHaveTextContent('Incorrect');
});

test('preference storage failures are visible without inventing successful persistence', () => {
  render(
    <ForecastPanel
      {...props({ preferencesWarning: 'Forecast preferences could not be saved.' })}
    />,
  );
  expect(screen.getByRole('alert')).toHaveTextContent('Forecast preferences could not be saved.');
});

test('legacy withheld forecasts report that no call was captured rather than a weak signal', () => {
  const withheld = fixed(9, {
    status: 'withheld',
    aboveProbability: null,
    belowProbability: null,
    withholdingReason: 'market-data-unavailable',
  });
  render(<ForecastPanel {...props({ recordedForecast: withheld })} />);
  expect(screen.queryByText('No clear signal')).not.toBeInTheDocument();
  expect(screen.getAllByText('No fixed call').length).toBeGreaterThan(0);
});
