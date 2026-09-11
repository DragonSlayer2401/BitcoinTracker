import { useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ForecastJournal from '../components/ForecastJournal';
import { selectJournalOutcomeGroups } from '../state/selectors/trackerSelectors';
import { KALSHI_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { KALSHI_MODEL_VERSION } from '../utils/kalshi/forecast.utils';

const NOW = Date.UTC(2026, 8, 8, 12, 0);
const forecasts = [
  {
    id: 'active',
    createdAt: NOW,
    expiresAt: NOW + 900_000,
    target: 50_000,
    aboveProbability: 0.65,
    belowProbability: 0.35,
    direction: 'above',
    status: 'pending',
  },
  {
    id: 'resolved',
    createdAt: NOW - 1_800_000,
    expiresAt: NOW - 900_000,
    target: 49_750,
    aboveProbability: 0.7,
    belowProbability: 0.3,
    direction: 'above',
    status: 'resolved',
    observedPrice: 49_800,
    observedAt: NOW - 895_000,
    outcome: 'above',
    correct: true,
  },
  {
    id: 'missed-outcome',
    createdAt: NOW - 3_600_000,
    expiresAt: NOW - 2_700_000,
    target: 49_500,
    aboveProbability: 0.5,
    belowProbability: 0.5,
    direction: 'neutral',
    status: 'unobserved',
  },
];
const summary = { scoredCount: 1, accuracy: 1, brierScore: 0.09 };

describe('ForecastJournal panel', () => {
  test('shows only the latest forecast in the panel and opens every record with full outcome details', async () => {
    const user = userEvent.setup();
    render(
      <ForecastJournal forecasts={forecasts} summary={summary} now={NOW} onClear={jest.fn()} />,
    );
    const panel = within(screen.getByRole('region', { name: 'Forecast history' }));

    expect(panel.getAllByRole('rowheader')).toHaveLength(1);
    expect(panel.getByRole('rowheader')).toHaveTextContent('$50,000.00');
    expect(panel.getByText('15:00')).toBeInTheDocument();
    expect(panel.queryByText('$49,750.00')).not.toBeInTheDocument();
    expect(
      panel.queryByRole('columnheader', { name: 'Settlement average' }),
    ).not.toBeInTheDocument();

    const openButton = panel.getByRole('button', { name: 'View history' });
    await user.click(openButton);
    const dialog = within(screen.getByRole('dialog', { name: 'Forecast history' }));

    expect(dialog.getAllByRole('rowheader')).toHaveLength(3);
    expect(dialog.getByRole('columnheader', { name: 'Yes / No' })).toBeInTheDocument();
    expect(dialog.getByRole('columnheader', { name: 'Settlement average' })).toBeInTheDocument();
    expect(dialog.getByText('$49,800.00')).toBeInTheDocument();
    expect(dialog.getByText('Official Kalshi settlement')).toBeInTheDocument();
    expect(dialog.getByText('Correct')).toBeInTheDocument();
    expect(dialog.getByText('Unobserved')).toBeInTheDocument();
    expect(dialog.getByText('100.0%')).toBeInTheDocument();
    expect(dialog.getByText('0.090')).toBeInTheDocument();
    expect(dialog.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(openButton).toHaveFocus();
    expect(panel.getAllByRole('rowheader')).toHaveLength(1);
  });

  test.each(['Close history', 'Close'])(
    'closes history using %s and restores the opening button',
    async (label) => {
      const user = userEvent.setup();
      render(
        <ForecastJournal forecasts={forecasts} summary={summary} now={NOW} onClear={jest.fn()} />,
      );
      const openButton = screen.getByRole('button', { name: 'View history' });
      await user.click(openButton);
      const dialog = within(screen.getByRole('dialog', { name: 'Forecast history' }));
      await user.click(dialog.getByRole('button', { name: label, exact: true }));

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(openButton).toHaveFocus();
    },
  );

  test('keeps cancellation separate from clearing and preserves the active forecast on confirmation', async () => {
    const user = userEvent.setup();
    const onClear = jest.fn();
    function JournalWithState() {
      const [entries, setEntries] = useState(forecasts);
      return (
        <ForecastJournal
          forecasts={entries}
          summary={summary}
          now={NOW}
          onClear={() => {
            onClear();
            setEntries((current) => current.filter((entry) => entry.status === 'pending'));
          }}
        />
      );
    }
    render(<JournalWithState />);
    const clearButton = screen.getByRole('button', { name: 'Clear completed' });
    await user.click(clearButton);
    let dialog = within(screen.getByRole('dialog', { name: 'Clear completed forecasts?' }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(dialog.getByRole('button', { name: 'Keep journal' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onClear).not.toHaveBeenCalled();
    expect(clearButton).toHaveFocus();

    await user.click(clearButton);
    dialog = within(screen.getByRole('dialog', { name: 'Clear completed forecasts?' }));
    await user.click(dialog.getByRole('button', { name: 'Clear completed' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onClear).toHaveBeenCalledTimes(1);
    const openButton = screen.getByRole('button', { name: 'View history' });
    await waitFor(() => expect(openButton).toHaveFocus());
    expect(screen.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();
    await user.click(openButton);
    dialog = within(screen.getByRole('dialog', { name: 'Forecast history' }));
    expect(dialog.getAllByRole('rowheader')).toHaveLength(1);
    expect(dialog.getByRole('rowheader')).toHaveTextContent('$50,000.00');
    expect(dialog.getByText('15:00')).toBeInTheDocument();
  });

  test('shows a concise empty state and makes the full history view available without a clear action', async () => {
    const user = userEvent.setup();
    render(
      <ForecastJournal
        forecasts={[]}
        summary={{ scoredCount: 0, accuracy: null, brierScore: null }}
        now={NOW}
        onClear={jest.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'No recorded forecasts' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Clear completed' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View history' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Forecast history' }));
    expect(dialog.getByRole('heading', { name: 'No recorded forecasts' })).toBeInTheDocument();
  });

  test('shows Kalshi metrics without retired forecast groups', async () => {
    const user = userEvent.setup();
    const entries = [
      {
        ...forecasts[1],
        outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
        analysis: { policyVersion: KALSHI_POLICY_VERSION },
        kalshiMarket: { ticker: 'KXBTC15M-TEST' },
        aboveProbability: 0.51,
        belowProbability: 0.49,
      },
    ];
    const outcomeGroups = selectJournalOutcomeGroups({ tracker: { forecasts: entries } });
    render(
      <ForecastJournal
        forecasts={entries}
        summary={summary}
        outcomeGroups={outcomeGroups}
        now={NOW}
        onClear={jest.fn()}
      />,
    );
    expect(screen.getByText(/Current policy accuracy:/)).toHaveTextContent('100.0%');
    await user.click(screen.getByRole('button', { name: 'View history' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Forecast history' }));
    expect(dialog.getByRole('heading', { name: 'Kalshi · official results' })).toBeVisible();
    expect(dialog.getByText(/Brier:/)).toHaveTextContent('0.240');
    expect(dialog.queryByText(/Coinbase pressure/)).not.toBeInTheDocument();
    expect(dialog.getByText(/Yes includes ties/)).toBeVisible();
  });

  test.each([
    [0.51, 'above', 'Slight lean Yes · at or above'],
    [0.49, 'below', 'Slight lean No · below'],
    [0.5, 'neutral', 'No directional edge'],
  ])(
    'labels a %s Kalshi estimate honestly without overstating its direction',
    (aboveProbability, direction, label) => {
      const entry = {
        ...forecasts[0],
        modelVersion: KALSHI_MODEL_VERSION,
        kalshiMarket: { ticker: 'KXBTC15M-TEST' },
        aboveProbability,
        belowProbability: 1 - aboveProbability,
        direction,
        analysis: { policyVersion: KALSHI_POLICY_VERSION },
      };
      render(
        <ForecastJournal forecasts={[entry]} summary={summary} now={NOW} onClear={jest.fn()} />,
      );
      expect(screen.getByText(label)).toBeVisible();
      expect(screen.queryByText(`Likely ${direction}`)).not.toBeInTheDocument();
    },
  );

  test('does not present earlier successful forecasts as measured accuracy for the new policy', () => {
    const entries = [
      {
        ...forecasts[1],
        analysis: { policyVersion: 'market-aware-consensus-v2' },
        outcomeDefinition: 'coinbase-last-trade-at-deadline-v1',
      },
    ];
    const outcomeGroups = selectJournalOutcomeGroups({ tracker: { forecasts: entries } });
    render(
      <ForecastJournal
        forecasts={entries}
        summary={summary}
        outcomeGroups={outcomeGroups}
        now={NOW}
        onClear={jest.fn()}
      />,
    );
    expect(screen.getByText(/Current policy accuracy:/)).toHaveTextContent('—');
    expect(screen.getByText(/Scored:/)).toHaveTextContent('0');
    expect(screen.getByText(/Call coverage:/)).toHaveTextContent('—');
  });
});
