import { screen, within } from '@testing-library/react';
import {
  renderLiveEstimates,
  selectEvent,
  setupLiveEstimateTests,
} from '../helpers/liveEstimateTestHarness';
import {
  createMarketFeed,
  createSavedForecast,
  currentMarket,
  eventEnd,
  eventStart,
  nextMarket,
} from '../helpers/liveEstimateFixtures';
import { getLiveEstimate, getLiveProbabilities } from './helpers/estimateQueries';

setupLiveEstimateTests();

test('shows connecting feedback and then a live estimate when fresh market inputs arrive', async () => {
  const view = await renderLiveEstimates({
    feedOverrides: { isLoading: true, benchmark: null, ticker: null, candles: [] },
  });
  expect(getLiveEstimate().getByRole('heading', { name: 'Connecting…' })).toBeVisible();
  expect(getLiveEstimate().getByText('Waiting for fresh market data.')).toBeVisible();
  expect(getLiveProbabilities()).not.toMatch(/\d/);
  expect(screen.queryByText('Settlement estimate details')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Start forecast' })).toBeDisabled();
  await view.update(eventStart + 1000, { price: 50_100 });
  expect(
    getLiveEstimate().getByRole('heading', { name: 'Likely Yes · at or above' }),
  ).toBeVisible();
  expect(getLiveProbabilities()).toMatch(/Yes · at or above \d.*%, No · below \d.*%/);
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
  expect(screen.getByText('Model estimates · not yet validated')).toBeVisible();
});

test.each([
  [
    'the official target',
    { ...currentMarket, target: null },
    {},
    'Waiting for Kalshi’s official target.',
  ],
  [
    'verified contract rules',
    { ...currentMarket, rulesVerified: false },
    {},
    'Kalshi contract details could not be verified.',
  ],
  [
    'a successful contract refresh',
    currentMarket,
    { hasContractError: true },
    'Kalshi contract details could not be verified.',
  ],
])(
  'waits for %s and resumes after the external feed recovers',
  async (_, market, feedOverrides, reason) => {
    const view = await renderLiveEstimates({ markets: [market, nextMarket], feedOverrides });
    expect(getLiveEstimate().getByRole('heading', { name: 'Estimate paused' })).toBeVisible();
    expect(getLiveEstimate().getByText(reason)).toBeVisible();
    expect(getLiveProbabilities()).not.toMatch(/\d/);
    expect(screen.queryByText('Settlement estimate details')).not.toBeInTheDocument();
    await view.update(eventStart + 1000, { markets: [currentMarket, nextMarket], price: 49_900 });
    expect(getLiveEstimate().getByRole('heading', { name: 'Likely No · below' })).toBeVisible();
    expect(screen.getByText('Settlement estimate details')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Start forecast' })).toBeEnabled();
  },
);

test('selects a future event with its target pending and returns to the current live estimate', async () => {
  const view = await renderLiveEstimates();
  await selectEvent(view.user, nextMarket);
  expect(getLiveEstimate().getByRole('heading', { name: 'Estimate paused' })).toBeVisible();
  expect(getLiveEstimate().getByText('Waiting for Kalshi’s official target.')).toBeVisible();
  expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(null);
  expect(screen.getByRole('button', { name: 'Schedule forecast' })).toBeEnabled();
  await selectEvent(view.user, currentMarket);
  expect(
    getLiveEstimate().queryByRole('heading', { name: 'Estimate paused' }),
  ).not.toBeInTheDocument();
  expect(getLiveProbabilities()).toContain('%');
  expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_000);
});

test('keeps an independent BRTI estimate available during a Coinbase outage, then pauses when both sources fail', async () => {
  const view = await renderLiveEstimates({
    feedOverrides: { hasRequestError: true, ticker: null, candles: [] },
  });
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
  expect(
    getLiveEstimate().queryByRole('heading', { name: 'Estimate paused' }),
  ).not.toBeInTheDocument();
  await view.update(eventStart + 1000, {
    benchmark: null,
    ticker: null,
    candles: [],
    hasRequestError: true,
  });
  expect(getLiveEstimate().getByRole('heading', { name: 'Estimate paused' })).toBeVisible();
  expect(
    getLiveEstimate().getByText('The market feed could not be refreshed. Retrying automatically.'),
  ).toBeVisible();
  expect(screen.queryByText('BRTI benchmark connected')).not.toBeInTheDocument();
  expect(getLiveProbabilities()).not.toMatch(/\d/);
  await view.update(eventStart + 2000, { price: 50_100 });
  expect(
    getLiveEstimate().getByRole('heading', { name: 'Likely Yes · at or above' }),
  ).toBeVisible();
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
});

test.each([
  ['insufficient history', { candles: [] }, /61 completed one-minute candles/],
  [
    'a stale quote',
    {
      ticker: {
        ...createMarketFeed(eventStart).ticker,
        time: eventStart - 21_000,
        receivedAt: eventStart - 21_000,
      },
    },
    /quote is stale/,
  ],
  [
    'missing candle minutes',
    { candles: createMarketFeed(eventStart).candles.filter((_, index) => index !== 90) },
    /missing, duplicate, or out-of-order minutes/,
  ],
])(
  'pauses the Coinbase fallback for %s and recovers with usable inputs',
  async (_, feedOverrides, reason) => {
    const view = await renderLiveEstimates({
      feedOverrides: { benchmark: null, ...feedOverrides },
    });
    expect(getLiveEstimate().getByRole('heading', { name: 'Estimate paused' })).toBeVisible();
    expect(getLiveEstimate().getByText(reason)).toBeVisible();
    expect(getLiveProbabilities()).not.toMatch(/\d/);
    await view.update(eventStart + 1000, { benchmark: null, price: 50_100 });
    expect(
      getLiveEstimate().getByRole('heading', { name: 'Likely Yes · at or above' }),
    ).toBeVisible();
    expect(
      screen.getByText('Coinbase proxy · BRTI access needed for the settlement feed'),
    ).toBeVisible();
  },
);

test('replaces a stale BRTI reference with the labeled proxy and reconnects to the benchmark', async () => {
  const view = await renderLiveEstimates();
  const staleBenchmark = createMarketFeed(eventStart).benchmark;
  await view.update(eventStart + 6000, { benchmark: staleBenchmark, price: 50_100 });
  expect(
    screen.getByText('Coinbase proxy · BRTI access needed for the settlement feed'),
  ).toBeVisible();
  expect(
    getLiveEstimate().getByRole('heading', { name: 'Likely Yes · at or above' }),
  ).toBeVisible();
  await view.update(eventStart + 7000, { price: 50_100 });
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
  expect(
    screen.queryByText('Coinbase proxy · BRTI access needed for the settlement feed'),
  ).not.toBeInTheDocument();
});

test('continues updating live probabilities while its captured checkpoint remains fixed through reload', async () => {
  const view = await renderLiveEstimates();
  await view.user.click(screen.getByRole('button', { name: 'Start forecast' }));
  await view.update(eventEnd - 9 * 60_000, { price: 50_100 });
  const savedRow = screen.getByRole('row', { name: /^9 min left/ });
  expect(savedRow).toHaveTextContent(/Yes.*Saved/);
  const savedCall = within(savedRow).getAllByRole('cell')[0].textContent;
  const previousLive = getLiveProbabilities();
  await view.update(eventEnd - 9 * 60_000 + 1000, { price: 49_900 });
  expect(getLiveEstimate().getByRole('heading', { name: 'Likely No · below' })).toBeVisible();
  expect(getLiveProbabilities()).not.toBe(previousLive);
  expect(
    within(screen.getByRole('row', { name: /^9 min left/ })).getAllByRole('cell')[0],
  ).toHaveTextContent(savedCall);
  await view.reload();
  expect(getLiveEstimate().getByRole('heading', { name: 'Likely No · below' })).toBeVisible();
  expect(
    within(screen.getByRole('row', { name: /^9 min left/ })).getAllByRole('cell')[0],
  ).toHaveTextContent(savedCall);
});

test('ends the saved window and follows the next event only after the user prepares a new forecast', async () => {
  const saved = createSavedForecast();
  const view = await renderLiveEstimates({ forecasts: [saved], now: eventStart + 600_000 });
  await view.update(eventEnd, {
    markets: [currentMarket, { ...nextMarket, target: 50_100, status: 'active' }],
  });
  expect(getLiveEstimate().getByRole('heading', { name: 'Window ended' })).toBeVisible();
  expect(screen.queryByText('Settlement estimate details')).not.toBeInTheDocument();
  await view.user.click(screen.getByRole('button', { name: 'New forecast' }));
  expect(getLiveEstimate().getByRole('heading', { name: 'Likely No · below' })).toBeVisible();
  expect(screen.getByText('Model estimates · not yet validated')).toBeVisible();
  expect(screen.getByRole('spinbutton', { name: 'Kalshi target price' })).toHaveValue(50_100);
});
