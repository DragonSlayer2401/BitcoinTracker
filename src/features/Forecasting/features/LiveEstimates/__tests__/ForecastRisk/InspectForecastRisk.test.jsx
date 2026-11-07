import { screen, waitFor, within } from '@testing-library/react';
import { renderLiveEstimates, setupLiveEstimateTests } from '../helpers/liveEstimateTestHarness';
import { createSavedForecast, eventEnd, eventStart } from '../helpers/liveEstimateFixtures';
import {
  closeForecastRisk,
  getFixedCall,
  getLiveProbability,
  openForecastRisk,
} from './helpers/riskQueries';

setupLiveEstimateTests();

describe('Inspecting risk against saved forecasts', () => {
  test.each([
    ['Yes', 0.8, 49_900, 'No'],
    ['No', 0.2, 50_100, 'Yes'],
  ])(
    'compares current loss risk with the saved %s call without changing it',
    async (savedSide, aboveProbability, price, oppositeSide) => {
      const now = eventStart + 7 * 60_000;
      const saved = createSavedForecast({ id: `saved-${savedSide}`, aboveProbability });
      const view = await renderLiveEstimates({ now, forecasts: [saved] });
      const capturedCall = getFixedCall(9);
      await view.update(now + 1000, { price });
      const currentLossProbability = getLiveProbability(oppositeSide);
      const history = await openForecastRisk(view.user);
      expect(history.getByText(/, opposite the fixed/)).toHaveTextContent(
        `of settling ${oppositeSide}, opposite the fixed ${savedSide} call.`,
      );
      expect(history.getByText(/Saved loss risk/)).toHaveTextContent('Saved loss risk 20.0%');
      expect(history.getByText(/Saved loss risk/)).toHaveTextContent(
        `current ${currentLossProbability.toFixed(1)}%`,
      );
      expect(history.getByText(/Saved loss risk/)).toHaveTextContent(
        `Increased by ${(currentLossProbability - 20).toFixed(1)} percentage points since capture`,
      );
      expect(history.getByText(/current reference price is on the side opposite/)).toBeVisible();
      expect(history.getByText(/fixed prediction has not changed/)).toBeVisible();
      expect(history.getByText(/Saved target/)).toHaveTextContent('Saved target $50,000.00');

      await view.update(now + 2000, { price: savedSide === 'Yes' ? 50_100 : 49_900 });
      expect(history.getByText(/Saved loss risk/)).toHaveTextContent(
        /Decreased by \d+\.\d percentage points since capture/,
      );
      expect(
        history.queryByText(/current reference price is on the side opposite/),
      ).not.toBeInTheDocument();
      await closeForecastRisk(view.user);
      expect(getFixedCall(9)).toBe(capturedCall);
    },
  );

  test('moves from observing risk to each newest fixed checkpoint as the user records the event', async () => {
    const view = await renderLiveEstimates();
    await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
    let risk = await openForecastRisk(view.user);
    expect(risk.getByText('The fixed prediction is still being observed.')).toBeVisible();
    expect(risk.getByRole('heading', { name: 'Flip from the current side' })).toBeVisible();
    await closeForecastRisk(view.user);

    await view.update(eventEnd - 9 * 60_000, { price: 50_100 });
    expect(screen.getByRole('button', { name: /9m call · Fixed loss risk/ })).toBeInTheDocument();
    const firstCall = getFixedCall(9);
    risk = await openForecastRisk(view.user);
    expect(risk.getByText(/Unchanged at the displayed precision since capture/)).toBeVisible();
    await closeForecastRisk(view.user);
    await view.update(eventEnd - 6 * 60_000, { price: 49_900 });
    expect(screen.getByRole('button', { name: /6m call · Fixed loss risk/ })).toBeInTheDocument();
    expect(getFixedCall(9)).toBe(firstCall);
    risk = await openForecastRisk(view.user);
    expect(risk.getByText(/, opposite the fixed/)).toHaveTextContent('opposite the fixed No call.');
    expect(risk.getByText(/Unchanged at the displayed precision since capture/)).toBeVisible();
    expect(risk.getByText(/Collecting about one minute/)).toBeVisible();
  });

  test.each([
    ['withheld', 0.8, 'No fixed prediction was issued for this window.'],
    ['pending', 0.5, 'The fixed prediction has no directional edge.'],
  ])(
    'explains a restored %s call without inventing directional loss risk',
    async (status, aboveProbability, reason) => {
      const saved = createSavedForecast({ id: `saved-${status}`, status, aboveProbability });
      const view = await renderLiveEstimates({ now: eventStart + 7 * 60_000, forecasts: [saved] });
      expect(screen.queryByRole('button', { name: /Fixed loss risk/ })).not.toBeInTheDocument();
      const risk = await openForecastRisk(view.user);
      expect(risk.getByText(reason)).toBeVisible();
      expect(risk.getByRole('heading', { name: 'Flip from the current side' })).toBeVisible();
      expect(risk.queryByText(/Saved loss risk/)).not.toBeInTheDocument();
      expect(risk.getByText(/Kalshi Yes/)).toHaveTextContent('Kalshi No');
    },
  );

  test('pauses risk during a feed outage, recovers in the open dialog, and ends at the saved close', async () => {
    const now = eventStart + 7 * 60_000;
    const saved = createSavedForecast({ id: 'recovering-risk' });
    const view = await renderLiveEstimates({ now, forecasts: [saved] });
    const risk = await openForecastRisk(view.user);
    expect(risk.getByRole('heading', { name: 'Risk to the fixed prediction' })).toBeVisible();
    await view.update(now + 1000, {
      benchmark: null,
      ticker: null,
      candles: [],
      hasRequestError: true,
    });
    expect(
      risk.getByText('Waiting for an estimate for the same saved contract and settlement rules.'),
    ).toBeVisible();
    expect(
      risk.queryByRole('heading', { name: 'Risk to the fixed prediction' }),
    ).not.toBeInTheDocument();
    await view.update(now + 2000, { price: 50_100 });
    expect(risk.getByRole('heading', { name: 'Risk to the fixed prediction' })).toBeVisible();
    expect(
      risk.queryByText('Waiting for an estimate for the same saved contract and settlement rules.'),
    ).not.toBeInTheDocument();
    await view.update(eventEnd);
    expect(risk.getByText('The window has ended. Live risk is no longer estimated.')).toBeVisible();
    expect(
      risk.queryByRole('heading', { name: 'Risk to the fixed prediction' }),
    ).not.toBeInTheDocument();
    await closeForecastRisk(view.user);
    expect(
      within(screen.getByRole('region', { name: 'Live estimate' })).getByRole('heading', {
        name: 'Window ended',
      }),
    ).toBeInTheDocument();
  });

  test('builds a minute of fresh risk observations and resets the trend after a connection gap', async () => {
    const now = eventStart + 7 * 60_000;
    const view = await renderLiveEstimates({ now, forecasts: [createSavedForecast()] });
    const risk = await openForecastRisk(view.user);
    expect(risk.getByText(/Collecting about one minute/)).toBeVisible();
    for (let seconds = 5; seconds <= 60; seconds += 5) {
      await view.update(now + seconds * 1000, { price: 50_000 + seconds });
    }
    expect(risk.getByText(/percentage point.*over 60 seconds/)).toBeVisible();
    expect(risk.queryByText(/Collecting about one minute/)).not.toBeInTheDocument();
    await view.update(now + 85_000, { price: 50_100 });
    expect(risk.getByText(/Collecting about one minute/)).toBeVisible();
    expect(risk.queryByText(/percentage point.*over 60 seconds/)).not.toBeInTheDocument();
  });

  test('starts a new risk trend when the reference changes from BRTI to the Coinbase proxy', async () => {
    const now = eventStart + 7 * 60_000;
    const view = await renderLiveEstimates({ now, forecasts: [createSavedForecast()] });
    const risk = await openForecastRisk(view.user);
    for (let seconds = 5; seconds <= 60; seconds += 5) {
      await view.update(now + seconds * 1000, { price: 50_000 + seconds });
    }
    expect(risk.getByText(/percentage point.*over 60 seconds/)).toBeVisible();
    expect(risk.getByText(/Current BRTI benchmark/)).toBeVisible();
    await view.update(now + 65_000, { benchmark: null, price: 50_100 });
    expect(risk.getByText(/Current Coinbase proxy/)).toBeVisible();
    expect(risk.getByText(/Collecting about one minute/)).toBeVisible();
    expect(risk.queryByText(/percentage point.*over 60 seconds/)).not.toBeInTheDocument();
  });

  test('shows fresh executed-flow and displayed-depth changes and drops them when they become stale', async () => {
    const now = eventStart + 7 * 60_000;
    const stream = {
      status: 'live',
      flow: {
        windows: {
          15: { available: true, buyBtc: 8, sellBtc: 2 },
          60: { available: true, buyBtc: 9, sellBtc: 22 },
        },
        impact: {
          asOf: now,
          available: true,
          samples: [
            {
              startAt: now - 15_000,
              endAt: now,
              startPrice: 50_010,
              endPrice: 50_000,
              buyBtc: 8,
              sellBtc: 2,
            },
          ],
        },
      },
      liquidity: {
        available: true,
        updatedAt: now,
        depthChange60: { available: true, bidFraction: -0.2, askFraction: -0.1 },
      },
    };
    const view = await renderLiveEstimates({
      now,
      forecasts: [createSavedForecast()],
      feedOverrides: { stream },
    });
    const risk = await openForecastRisk(view.user);
    expect(
      risk.getByText(
        'Executed flow changed from net selling in the preceding 45 seconds to net buying in the latest 15 seconds.',
      ),
    ).toBeVisible();
    expect(
      risk.getByText(
        'Net buying did not lift the price in the latest verified 15-second interval.',
      ),
    ).toBeVisible();
    expect(risk.getByText(/Buy-side displayed depth.*20.0%/)).toBeVisible();
    expect(risk.getByText(/Sell-side displayed depth.*10.0%/)).toBeVisible();
    expect(
      risk.getByText(/do not establish its cause or add separate percentage bonuses/),
    ).toBeVisible();
    await view.update(now + 6000, { stream });
    expect(risk.queryByText(/Executed flow changed/)).not.toBeInTheDocument();
    expect(risk.queryByText(/Net buying did not lift/)).not.toBeInTheDocument();
    expect(risk.queryByText(/side displayed depth/)).not.toBeInTheDocument();
  });

  test.each(['Close forecast risk', 'Close', 'Escape'])(
    'closes risk with %s and restores focus to the risk control',
    async (closeAction) => {
      const view = await renderLiveEstimates({
        now: eventStart + 7 * 60_000,
        forecasts: [createSavedForecast()],
      });
      const riskButton = screen.getByRole('button', { name: /view estimated deadline risk/ });
      const risk = await openForecastRisk(view.user);
      expect(screen.getByRole('dialog', { name: 'Deadline and reversal risk' })).toBeVisible();
      if (closeAction === 'Escape') await view.user.keyboard('{Escape}');
      else await view.user.click(risk.getByRole('button', { name: closeAction, exact: true }));
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect(riskButton).toHaveFocus();
      await view.user.keyboard('{Enter}');
      expect(
        await screen.findByRole('dialog', { name: 'Deadline and reversal risk' }),
      ).toBeVisible();
    },
  );
});
