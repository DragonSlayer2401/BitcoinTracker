import { render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ForecastRisk from '../components/ForecastRisk';
import useRiskTrend from '../hooks/useRiskTrend';
import { getReversalObservations, getReversalRisk } from '../utils/reversalRisk.utils';

const now = 1_800_000_000_000;
const fixedForecast = {
  id: 'saved-window',
  target: 100_000,
  expiresAt: now + 600_000,
  direction: 'above',
  aboveProbability: 0.68,
  belowProbability: 0.32,
  status: 'pending',
};
const input = {
  now,
  fixedForecast,
  forecast: {
    available: true,
    target: fixedForecast.target,
    expiresAt: fixedForecast.expiresAt,
    aboveProbability: 0.57,
    belowProbability: 0.43,
  },
  ticker: { price: 100_010, time: now, receivedAt: now },
};

describe('deadline risk probabilities', () => {
  test('uses the current opposite-side odds without changing the fixed snapshot', () => {
    const saved = { ...fixedForecast };
    expect(getReversalRisk({ ...input, fixedForecast: saved })).toMatchObject({
      available: true,
      fixedFailureProbability: 0.43,
      currentSideFlipProbability: 0.43,
      currentSide: 'above',
      oppositeSide: 'below',
      isAgainstFixedCall: false,
    });
    expect(saved).toEqual(fixedForecast);
  });

  test('distinguishes an already crossed price from finishing opposite the current side', () => {
    expect(getReversalRisk({ ...input, ticker: { ...input.ticker, price: 99_990 } })).toMatchObject(
      {
        fixedFailureProbability: 0.43,
        currentSideFlipProbability: 0.57,
        currentSide: 'below',
        oppositeSide: 'above',
        isAgainstFixedCall: true,
      },
    );
  });

  test('a Below call uses current Above probability as its failure risk', () => {
    expect(
      getReversalRisk({ ...input, fixedForecast: { ...fixedForecast, direction: 'below' } }),
    ).toMatchObject({
      fixedFailureProbability: 0.57,
      fixedFailureSide: 'above',
      isAgainstFixedCall: true,
    });
  });

  test('exactly-at-target price has no current-side flip, while a directional call has risk', () => {
    expect(
      getReversalRisk({ ...input, ticker: { ...input.ticker, price: 100_000 } }),
    ).toMatchObject({
      fixedFailureProbability: 0.43,
      currentSideFlipProbability: null,
      currentSide: 'at',
      oppositeSide: null,
    });
  });

  test('a balanced fixed snapshot does not invent a directional failure rate', () => {
    expect(
      getReversalRisk({
        ...input,
        fixedForecast: {
          ...fixedForecast,
          direction: 'neutral',
          aboveProbability: 0.5,
          belowProbability: 0.5,
        },
      }),
    ).toMatchObject({
      fixedFailureProbability: null,
      currentSideFlipProbability: 0.43,
      fixedReason: 'The fixed prediction has no directional edge.',
    });
  });

  test.each(['analyzing', 'withheld'])(
    'a %s window has no issued-call failure probability',
    (status) => {
      expect(
        getReversalRisk({
          ...input,
          fixedForecast: { ...fixedForecast, status, direction: 'neutral' },
        }),
      ).toMatchObject({
        fixedFailureProbability: null,
        currentSideFlipProbability: 0.43,
      });
    },
  );

  test.each([
    ['draft target', { target: 99_000 }],
    ['different deadline', { expiresAt: fixedForecast.expiresAt + 1000 }],
    ['missing target anchor', { target: undefined }],
    ['missing deadline anchor', { expiresAt: undefined }],
  ])('rejects an estimate with %s', (_, changed) => {
    expect(
      getReversalRisk({ ...input, forecast: { ...input.forecast, ...changed } }),
    ).toMatchObject({
      available: false,
      fixedFailureProbability: null,
      currentSideFlipProbability: null,
      reason: 'Waiting for an estimate for the saved target and deadline.',
    });
  });

  test.each([
    { aboveProbability: 0.9 },
    { aboveProbability: NaN },
    { belowProbability: -0.1 },
    { available: false },
  ])('does not display unavailable or malformed odds %j', (changed) => {
    expect(
      getReversalRisk({ ...input, forecast: { ...input.forecast, ...changed } }).available,
    ).toBe(false);
  });

  test.each([
    { time: now - 20_001 },
    { receivedAt: now - 20_001 },
    { time: now + 5001 },
    { price: 0 },
  ])('hides risk for invalid or stale market data %j', (changed) => {
    expect(getReversalRisk({ ...input, ticker: { ...input.ticker, ...changed } }).available).toBe(
      false,
    );
  });

  test('risk stops at the exact deadline', () => {
    expect(getReversalRisk({ ...input, now: fixedForecast.expiresAt })).toMatchObject({
      available: false,
      fixedFailureProbability: null,
      reason: 'The window has ended. Live risk is no longer estimated.',
    });
  });
});

describe('observed reversal context', () => {
  const flow = {
    status: 'live',
    flow: {
      impact: { asOf: now, available: false, samples: [] },
      windows: {
        15: { available: true, buyBtc: 1, sellBtc: 4 },
        60: { available: true, buyBtc: 9, sellBtc: 5 },
      },
    },
  };

  test('compares nonoverlapping executed trade windows to detect a buying-to-selling turn', () => {
    expect(getReversalObservations({ stream: flow, now })).toContainEqual({
      code: 'flow-turn',
      text: 'Executed flow changed from net buying in the preceding 45 seconds to net selling in the latest 15 seconds.',
    });
  });

  test('does not describe an overlapping total as earlier selling', () => {
    const stream = {
      ...flow,
      flow: {
        ...flow.flow,
        windows: {
          15: { available: true, buyBtc: 1, sellBtc: 10 },
          60: { available: true, buyBtc: 2, sellBtc: 11 },
        },
      },
    };
    expect(getReversalObservations({ stream, now })).toEqual([]);
  });

  test.each([
    { status: 'reconnecting' },
    { flow: { ...flow.flow, impact: { asOf: now - 5001 } } },
    { flow: { ...flow.flow, windows: { 15: { available: false }, 60: flow.flow.windows[60] } } },
  ])('suppresses stale or incomplete flow context %j', (changed) => {
    expect(getReversalObservations({ stream: { ...flow, ...changed }, now })).toEqual([]);
  });

  test('shows actual buying without a price rise without inventing a probability adjustment', () => {
    const stream = {
      ...flow,
      flow: {
        windows: {},
        impact: {
          asOf: now,
          available: true,
          samples: [
            {
              startAt: now - 15_000,
              endAt: now,
              startPrice: 100,
              endPrice: 99,
              buyBtc: 5,
              sellBtc: 2,
            },
          ],
        },
      },
    };
    expect(getReversalObservations({ stream, now })).toEqual([
      {
        code: 'buying-without-rise',
        text: 'Net buying did not lift the price in the latest verified 15-second interval.',
      },
    ]);
  });

  test('reports fresh shrinking displayed liquidity with cancellation context', () => {
    expect(
      getReversalObservations({
        now,
        stream: {
          liquidity: {
            available: true,
            updatedAt: now,
            depthChange60: { available: true, bidFraction: -0.2, askFraction: null },
          },
        },
      }),
    ).toEqual([
      {
        code: 'bid-depth-falling',
        text: 'Buy-side displayed depth within 0.1% of the midpoint decreased by 20.0% over 60 seconds. Orders may be canceled.',
      },
    ]);
  });

  test('derives a price turn from consecutive completed three-minute moves', () => {
    expect(
      getReversalObservations({
        now,
        conditions: {
          available: true,
          features: {
            latestCompletedAt: now,
            logReturn3Minutes: -0.001,
            logReturnAcceleration3Minutes: -0.003,
          },
        },
      }),
    ).toEqual([
      {
        code: 'price-turn',
        text: 'Completed three-minute price movement changed from rising to falling.',
      },
    ]);
  });
});

describe('risk trend continuity', () => {
  const initial = {
    id: fixedForecast.id,
    target: fixedForecast.target,
    expiresAt: fixedForecast.expiresAt,
    probability: 0.3,
    quoteTime: now,
    now,
  };

  test('compares a minute of fresh quotes and resets when the saved window changes', () => {
    const { result, rerender } = renderHook((props) => useRiskTrend(props), {
      initialProps: initial,
    });
    for (let seconds = 5; seconds <= 60; seconds += 5) {
      rerender({
        ...initial,
        now: now + seconds * 1000,
        quoteTime: now + seconds * 1000,
        probability: 0.3 + seconds / 1000,
      });
    }
    expect(result.current.percentagePoints).toBeCloseTo(6);
    expect(result.current.elapsedSeconds).toBe(60);
    rerender({ ...initial, id: 'another-window', now: now + 60_000, quoteTime: now + 60_000 });
    expect(result.current).toBeNull();
  });

  test('does not create observations from repeated quotes or bridge a data gap', () => {
    const { result, rerender } = renderHook((props) => useRiskTrend(props), {
      initialProps: initial,
    });
    for (let seconds = 5; seconds <= 60; seconds += 5) {
      rerender({ ...initial, now: now + seconds * 1000 });
    }
    expect(result.current).toBeNull();
    rerender({ ...initial, now: now + 65_000, quoteTime: now + 65_000, probability: 0.8 });
    expect(result.current).toBeNull();
  });
});

describe('risk dialog', () => {
  test('exposes estimated risk, the immutable reference, and restores keyboard focus', async () => {
    const user = userEvent.setup();
    const submit = jest.fn((event) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <ForecastRisk {...input} />
      </form>,
    );
    const button = screen.getByRole('button', {
      name: 'Fixed-call risk · 43.0%, view estimated deadline risk',
    });
    await user.click(button);
    const dialog = within(screen.getByRole('dialog', { name: 'Deadline and reversal risk' }));
    expect(dialog.getByText(/Saved target/)).toHaveTextContent('$100,000.00');
    expect(dialog.getByText(/Saved target/)).toHaveTextContent('not a temporary crossing');
    expect(
      dialog.getByText(
        (_, element) =>
          element.tagName === 'P' &&
          element.textContent.includes('estimated chance of finishing below the saved target'),
      ),
    ).toHaveTextContent('43.0%');
    expect(dialog.getByText(/Editing the preview target does not change/)).toBeVisible();
    expect(
      dialog.getByText(/Estimated probabilities are not a validated success rate/),
    ).toBeVisible();
    expect(submit).not.toHaveBeenCalled();
    await user.click(dialog.getByRole('button', { name: 'Close forecast risk' }));
    expect(button).toHaveFocus();
  });

  test('explains a currently opposing price and gives coherent distinct risks', async () => {
    const user = userEvent.setup();
    render(<ForecastRisk {...input} ticker={{ ...input.ticker, price: 99_990 }} />);
    await user.click(screen.getByRole('button', { name: /Fixed-call risk/ }));
    const dialog = within(screen.getByRole('dialog'));
    expect(dialog.getByText(/Currently below/)).toHaveTextContent('already on the side opposite');
    expect(
      dialog.getByText(
        (_, element) =>
          element.tagName === 'P' &&
          element.textContent.includes(
            'estimated chance of finishing above, opposite the current price side',
          ),
      ),
    ).toHaveTextContent('57.0%');
  });

  test('an exact-price tie is distinct from neutral model probabilities', async () => {
    const user = userEvent.setup();
    render(<ForecastRisk {...input} ticker={{ ...input.ticker, price: 100_000 }} />);
    await user.click(screen.getByRole('button', { name: /Fixed-call risk/ }));
    expect(screen.getByText(/no current side to flip from/)).toBeVisible();
    expect(
      screen.getByText(/does not assign a separate probability to an exact-price tie/),
    ).toBeVisible();
  });

  test('an expired window hides old percentages instead of showing them as live', async () => {
    const user = userEvent.setup();
    render(<ForecastRisk {...input} now={fixedForecast.expiresAt} />);
    await user.click(screen.getByRole('button', { name: /Forecast risk/ }));
    const dialog = within(screen.getByRole('dialog'));
    expect(
      dialog.getByText('The window has ended. Live risk is no longer estimated.'),
    ).toBeVisible();
    expect(dialog.queryByText('43.0%')).not.toBeInTheDocument();
  });
});
