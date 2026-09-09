import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ForecastPanel from '../components/ForecastPanel';
import ForecastJournal from '../components/ForecastJournal';
import Methodology from '../components/Methodology';

const NOW = Date.UTC(2026, 8, 8, 12, 0);
const MINUTE = 60_000;
const makeObservation = (overrides = {}) => ({
  id: 'observation-1',
  startsAt: NOW,
  createdAt: NOW,
  expiresAt: NOW + 15 * MINUTE,
  target: 70_000,
  status: 'analyzing',
  direction: 'neutral',
  aboveProbability: null,
  belowProbability: null,
  modelVersion: 'trade-pressure-log-return-v1',
  calculationMode: null,
  analysis: {
    startedAt: NOW,
    earliestAt: NOW + 3 * MINUTE,
    deadline: NOW + 5 * MINUTE,
    policyVersion: 'pressure-snapshot-v3',
  },
  ...overrides,
});
const makeLegacyObservation = (overrides = {}) => {
  const entry = makeObservation(overrides);
  delete entry.calculationMode;
  return {
    ...entry,
    modelVersion: 'zero-drift-log-return-v1',
    analysis: { ...entry.analysis, policyVersion: 'observed-consensus-v1' },
  };
};
const liveForecast = {
  available: true,
  direction: 'above',
  aboveProbability: 0.72,
  belowProbability: 0.28,
};
const defaultProps = {
  targetInput: '70000',
  onTargetChange: jest.fn(),
  ticker: { time: NOW, price: 70_010 },
  forecast: liveForecast,
  forecastDeadline: NOW + 15 * MINUTE,
  timingSelection: { mode: 'now', value: '', timestamp: null },
  onTimingChange: jest.fn(),
  onRecord: jest.fn(),
  onNewForecast: jest.fn(),
  isJournalReady: true,
  now: NOW + MINUTE,
};

describe('fixed observation display', () => {
  test('shows observation progress without a fixed probability while retaining Live and target editing', () => {
    const entry = makeObservation();
    const { rerender } = render(
      <ForecastPanel
        {...defaultProps}
        activeForecast={entry}
        recordedForecast={entry}
        fixedProgress={{ phase: 'observing', observationRemainingMs: 120_000, sampleCount: 2 }}
      />,
    );
    const fixed = within(screen.getByRole('region', { name: 'Fixed prediction' }));
    expect(fixed.getByRole('heading', { name: 'Observing market' })).toBeVisible();
    expect(fixed.getByRole('timer')).toHaveTextContent('02:00');
    expect(fixed.queryByText(/Qualifying quotes/)).not.toBeInTheDocument();
    expect(fixed.getByText(/recorded after three minutes of observation/)).toHaveTextContent(
      'even when the edge is small',
    );
    expect(fixed.queryByRole('img')).not.toBeInTheDocument();
    expect(fixed.queryByText('72.0%')).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Live estimate' })).getByText('72.0%'),
    ).toBeVisible();
    expect(screen.getByRole('timer', { name: 'Time remaining' })).toHaveTextContent('14:00');
    expect(screen.queryByRole('button', { name: 'New forecast' })).not.toBeInTheDocument();
    const targetInput = screen.getByRole('spinbutton', { name: 'Target price' });
    expect(targetInput).toBeEnabled();
    fireEvent.change(targetInput, { target: { value: '71000' } });
    expect(defaultProps.onTargetChange).toHaveBeenCalledWith('71000');

    rerender(
      <ForecastPanel
        {...defaultProps}
        targetInput="71000"
        activeForecast={entry}
        recordedForecast={entry}
        fixedProgress={{ phase: 'observing', observationRemainingMs: 119_000, sampleCount: 2 }}
      />,
    );
    expect(fixed.getByText('Saved target $70,000.00')).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Live estimate' })).getByText(
        'Preview target $71,000.00',
      ),
    ).toBeVisible();
  });

  test('keeps the remaining consensus time visible for an earlier saved policy', () => {
    const entry = makeLegacyObservation();
    render(
      <ForecastPanel
        {...defaultProps}
        now={NOW + 3 * MINUTE}
        activeForecast={entry}
        recordedForecast={entry}
        fixedProgress={{
          phase: 'confirming',
          observationRemainingMs: 0,
          confirmationRemainingMs: 30_000,
          sampleCount: 4,
        }}
      />,
    );
    const fixed = within(screen.getByRole('region', { name: 'Fixed prediction' }));
    expect(fixed.getByRole('heading', { name: 'Waiting for a clear signal' })).toBeVisible();
    expect(fixed.getByText(/Signal confirmation/)).toBeVisible();
    expect(fixed.getByRole('timer')).toHaveTextContent('00:30');
    expect(fixed.getByText('Qualifying quotes: 4')).toBeVisible();
    expect(fixed.getByText(/Earlier policy:/)).toHaveTextContent('≥65%');
    expect(fixed.queryByRole('img')).not.toBeInTheDocument();
  });

  test('after three minutes the new policy waits for fresh data without asking for signal agreement', () => {
    const entry = makeObservation();
    render(
      <ForecastPanel
        {...defaultProps}
        now={NOW + 3 * MINUTE}
        activeForecast={entry}
        recordedForecast={entry}
        fixedProgress={{
          phase: 'confirming',
          reason: 'Waiting for a valid estimate from fresh market data.',
          observationRemainingMs: 0,
          confirmationRemainingMs: 0,
          sampleCount: 0,
        }}
      />,
    );
    const fixed = within(screen.getByRole('region', { name: 'Fixed prediction' }));
    expect(fixed.getByRole('heading', { name: 'Waiting for fresh data' })).toBeVisible();
    expect(fixed.getByText(/Decision window/)).toHaveTextContent('02:00');
    expect(fixed.queryByText(/Signal confirmation|Qualifying quotes|65%/)).not.toBeInTheDocument();
    expect(fixed.queryByRole('img')).not.toBeInTheDocument();
  });

  test.each([
    ['above', 0.51, 'Slight lean above'],
    ['below', 0.49, 'Slight lean below'],
    ['neutral', 0.5, 'No directional edge'],
  ])(
    'shows an issued %s estimate with its original weak or balanced probabilities',
    (direction, aboveProbability, heading) => {
      const entry = makeObservation({
        status: 'pending',
        createdAt: NOW + 3 * MINUTE,
        direction,
        aboveProbability,
        belowProbability: 1 - aboveProbability,
        calculationMode: 'baseline-fallback',
      });
      render(
        <ForecastPanel
          {...defaultProps}
          now={NOW + 4 * MINUTE}
          activeForecast={entry}
          recordedForecast={entry}
        />,
      );
      const fixed = within(screen.getByRole('region', { name: 'Fixed prediction' }));
      expect(fixed.getByRole('heading', { name: heading })).toBeVisible();
      expect(
        fixed.getByRole('img', {
          name: `Above target ${(aboveProbability * 100).toFixed(1)}%, below target ${((1 - aboveProbability) * 100).toFixed(1)}%`,
        }),
      ).toBeVisible();
      expect(fixed.getByText('Fixed prediction · Price only')).toBeVisible();
      expect(fixed.queryByText('No clear signal')).not.toBeInTheDocument();
    },
  );

  test('reports an interrupted data feed instead of implying a trustworthy fixed prediction', () => {
    const entry = makeObservation();
    render(
      <ForecastPanel
        {...defaultProps}
        activeForecast={entry}
        recordedForecast={entry}
        fixedProgress={{
          phase: 'observing',
          reason: 'Waiting for fresh, uninterrupted market data.',
          observationRemainingMs: 120_000,
          sampleCount: 0,
        }}
      />,
    );
    const fixed = within(screen.getByRole('region', { name: 'Fixed prediction' }));
    expect(fixed.getByText('Waiting for fresh, uninterrupted market data.')).toBeVisible();
    expect(fixed.queryByRole('img')).not.toBeInTheDocument();
  });

  test.each([
    ['insufficient-time', /Not enough time/],
    ['no-consensus', /No direction met the signal rule/],
    ['market-data-unavailable', /Fresh, uninterrupted market data was unavailable/],
  ])(
    'displays a no-call reason for %s with no fixed percentages',
    async (withholdingReason, message) => {
      const user = userEvent.setup();
      const makeEntry =
        withholdingReason === 'no-consensus' ? makeLegacyObservation : makeObservation;
      const entry = makeEntry({ status: 'withheld', withholdingReason });
      const onNewForecast = jest.fn();
      render(
        <ForecastPanel {...defaultProps} recordedForecast={entry} onNewForecast={onNewForecast} />,
      );
      const fixed = within(screen.getByRole('region', { name: 'Fixed prediction' }));
      expect(fixed.getByRole('heading', { name: 'No clear signal' })).toBeVisible();
      expect(fixed.getByText(message)).toBeVisible();
      expect(fixed.queryByRole('img')).not.toBeInTheDocument();
      expect(fixed.queryByRole('timer')).not.toBeInTheDocument();
      expect(
        within(screen.getByRole('region', { name: 'Live estimate' })).getByText('72.0%'),
      ).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'New forecast' }));
      expect(onNewForecast).toHaveBeenCalledTimes(1);
    },
  );

  test('keeps older immediate forecasts visible with their captured probabilities', () => {
    const entry = makeObservation({
      status: 'pending',
      analysis: undefined,
      modelVersion: 'zero-drift-log-return-v1',
      calculationMode: undefined,
      direction: 'above',
      aboveProbability: 0.7,
      belowProbability: 0.3,
    });
    render(<ForecastPanel {...defaultProps} activeForecast={entry} recordedForecast={entry} />);
    const fixed = within(screen.getByRole('region', { name: 'Fixed prediction' }));
    expect(fixed.getByText('70.0%')).toBeVisible();
    expect(fixed.getByText('30.0%')).toBeVisible();
    expect(fixed.queryByText('Observing market')).not.toBeInTheDocument();
  });
});

describe('observation history and rules', () => {
  const summary = {
    scoredCount: 0,
    accuracy: null,
    brierScore: null,
    analysisCount: 0,
    withheldCount: 1,
    callCount: 0,
    coverage: 0,
  };

  test('shows no calls separately from incorrect predictions and exposes coverage', async () => {
    const user = userEvent.setup();
    render(
      <ForecastJournal
        forecasts={[
          makeLegacyObservation({ status: 'withheld', withholdingReason: 'no-consensus' }),
        ]}
        summary={summary}
        now={NOW}
      />,
    );
    expect(screen.getByText('No call · unscored')).toBeVisible();
    expect(screen.queryByText('Incorrect')).not.toBeInTheDocument();
    expect(screen.getByText(/Call coverage:/)).toHaveTextContent('0.0%');
    await user.click(screen.getByRole('button', { name: 'View history' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Forecast history' }));
    expect(dialog.getByText('Not issued')).toBeVisible();
    expect(dialog.queryByText('Incorrect')).not.toBeInTheDocument();
  });

  test('does not offer to clear an ongoing observation as a completed forecast', () => {
    render(
      <ForecastJournal
        forecasts={[makeObservation()]}
        summary={{ ...summary, analysisCount: 1, withheldCount: 0 }}
        now={NOW}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();
    expect(screen.getAllByText('Observing')).toHaveLength(2);
    expect(screen.queryByText('Incorrect')).not.toBeInTheDocument();
  });

  test('explains the new capture rule without claiming the pressure adjustment improves accuracy', async () => {
    const user = userEvent.setup();
    render(<Methodology />);
    await user.click(screen.getByRole('button', { name: 'View model rules' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Model and data rules' }));
    expect(dialog.getByText(/New windows observe for three minutes/)).toHaveTextContent(
      'There is no 65% minimum and no full minute of matching directional signals',
    );
    expect(
      dialog.getByText(/closes after 5 minutes or one minute before the original end/),
    ).toBeVisible();
    expect(dialog.getByText(/not a proven ability to predict future returns/)).toBeVisible();
    expect(
      dialog.getByText(
        /Predictive accuracy and interval coverage have not been independently validated/,
      ),
    ).toBeVisible();
  });
});
