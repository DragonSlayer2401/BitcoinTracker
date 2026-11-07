import { screen } from '@testing-library/react';
import { renderLiveEstimates, setupLiveEstimateTests } from '../helpers/liveEstimateTestHarness';
import { eventStart } from '../helpers/liveEstimateFixtures';
import { createFuturesSnapshot, createSpotStream } from './helpers/pressureSnapshots';
import { getDisplayedYesChance, getLiveEstimate } from './helpers/modelInputQueries';

setupLiveEstimateTests();

test.each([
  ['buy', 'stale'],
  ['sell', 'disconnected'],
])(
  'follows %s futures pressure from warmup through an applied estimate and %s recovery',
  async (direction, interruption) => {
    const now = eventStart + 600_000;
    const futures = createFuturesSnapshot(now, direction);
    const view = await renderLiveEstimates({
      now,
      feedOverrides: {
        derivatives: {
          ...futures,
          status: 'warming',
          impact: { ...futures.impact, available: false, samples: [] },
        },
      },
    });
    expect(getLiveEstimate().getByText('Live estimate · Price only')).toBeVisible();
    expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
    const baselineChance = getDisplayedYesChance();

    await view.update(now, { derivatives: futures });
    expect(getLiveEstimate().getByText('Live estimate · Futures pressure')).toBeVisible();
    expect(
      getLiveEstimate().getByTitle(
        'Bybit futures activity changes the estimated Kalshi settlement probability',
      ),
    ).toHaveTextContent('Kalshi close');
    if (direction === 'buy') expect(getDisplayedYesChance()).toBeGreaterThan(baselineChance);
    else expect(getDisplayedYesChance()).toBeLessThan(baselineChance);
    await view.user.click(screen.getByText('Settlement estimate details'));
    expect(screen.getByText('BRTI · 20 complete minutes')).toBeVisible();

    const interruptedAt = now + 15_000;
    await view.update(interruptedAt, {
      derivatives:
        interruption === 'stale'
          ? futures
          : { ...createFuturesSnapshot(interruptedAt, direction), status: 'disconnected' },
    });
    expect(getLiveEstimate().getByText('Live estimate · Price only')).toBeVisible();
    expect(getLiveEstimate().queryByText(/Futures pressure/)).not.toBeInTheDocument();
    expect(
      getLiveEstimate().queryByRole('heading', { name: 'Estimate paused' }),
    ).not.toBeInTheDocument();
    expect(getLiveEstimate().getByRole('img')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/Yes · at or above \d+\.\d%/),
    );
    expect(screen.getByText('BRTI benchmark connected')).toBeVisible();

    const recoveredAt = now + 30_000;
    await view.update(recoveredAt, { derivatives: createFuturesSnapshot(recoveredAt, direction) });
    expect(getLiveEstimate().getByText('Live estimate · Futures pressure')).toBeVisible();
    expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
  },
);

test.each([
  ['buy', 'Buying pressure', 'toward Above'],
  ['sell', 'Selling pressure', 'toward Below'],
])(
  'shows applied spot %s pressure, then returns to price-only estimates when trade evidence becomes stale',
  async (direction, label, caption) => {
    const now = eventStart + 600_000;
    const view = await renderLiveEstimates({ now });
    expect(getLiveEstimate().getByText('Live estimate · Price only')).toBeVisible();
    const baselineChance = getDisplayedYesChance();
    const stream = createSpotStream(now, direction);

    await view.update(now, { stream });
    expect(getLiveEstimate().getByText(`Live estimate · ${label}`)).toBeVisible();
    expect(getLiveEstimate().getByTitle(`Trade pressure ${caption}`)).toHaveTextContent(
      'Kalshi close',
    );
    if (direction === 'buy') expect(getDisplayedYesChance()).toBeGreaterThan(baselineChance);
    else expect(getDisplayedYesChance()).toBeLessThan(baselineChance);
    expect(screen.getByText('BRTI benchmark connected')).toBeVisible();

    await view.update(now + 15_000, { stream });
    expect(getLiveEstimate().getByText('Live estimate · Price only')).toBeVisible();
    expect(getLiveEstimate().queryByText(`Live estimate · ${label}`)).not.toBeInTheDocument();
    expect(
      getLiveEstimate().queryByRole('heading', { name: 'Estimate paused' }),
    ).not.toBeInTheDocument();
    expect(getLiveEstimate().getByRole('img')).toHaveAttribute(
      'aria-label',
      expect.stringMatching(/Yes · at or above \d+\.\d%/),
    );
  },
);
