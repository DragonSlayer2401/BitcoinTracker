import { screen } from '@testing-library/react';
import { renderLiveEstimates, setupLiveEstimateTests } from '../helpers/liveEstimateTestHarness';
import { createMarketFeed, eventEnd, eventStart } from '../helpers/liveEstimateFixtures';
import { createFinalMinuteBenchmark, getDetailValue } from './helpers/settlementDetails';

setupLiveEstimateTests();

test('reaches settlement details by keyboard and expands the index history behind the live estimate', async () => {
  const view = await renderLiveEstimates();
  const disclosure = screen.getByText('Settlement estimate details');
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
  expect(getDetailValue('Reference')).not.toBeVisible();

  await view.user.tab();
  expect(disclosure).toHaveFocus();
  await view.user.click(disclosure);
  expect(getDetailValue('Reference')).toBeVisible();
  expect(getDetailValue('Reference')).toHaveTextContent(/\$[\d,]+\.\d{2} · BRTI/);
  expect(getDetailValue('Price history')).toHaveTextContent('BRTI · 20 complete minutes');
  expect(getDetailValue('Minute volatility')).toHaveTextContent(/^\d+\.\d{3}%$/);
  expect(getDetailValue('Final-minute readings')).toHaveTextContent('0 / 60');
  expect(getDetailValue('Missing elapsed readings')).toHaveTextContent('0');
  expect(getDetailValue('Estimated average')).toHaveTextContent(/^\$[\d,]+\.\d{2}$/);
  expect(screen.queryByText('Remaining average for Yes')).not.toBeInTheDocument();
  expect(
    screen.getByText('Model approximation. Kalshi’s official result determines settlement.'),
  ).toBeVisible();

  await view.user.click(disclosure);
  expect(getDetailValue('Reference')).not.toBeVisible();
  expect(disclosure).toHaveFocus();
  await view.user.click(disclosure);
  expect(getDetailValue('Reference')).toBeVisible();
});

test('identifies the Coinbase proxy and its candle history, then updates the open details when BRTI returns', async () => {
  const view = await renderLiveEstimates({ feedOverrides: { benchmark: null } });
  await view.user.click(screen.getByText('Settlement estimate details'));
  expect(
    screen.getByText('Coinbase proxy · BRTI access needed for the settlement feed'),
  ).toBeVisible();
  expect(getDetailValue('Reference')).toHaveTextContent('$50,000.00 · proxy');
  expect(getDetailValue('Price history')).toHaveTextContent('Coinbase candles');
  expect(getDetailValue('Minute volatility')).toHaveTextContent(/^\d+\.\d{3}%$/);

  await view.update(eventStart + 1000);
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
  expect(getDetailValue('Reference')).toBeVisible();
  expect(getDetailValue('Reference')).toHaveTextContent('BRTI');
  expect(getDetailValue('Price history')).toHaveTextContent(/BRTI · \d+ complete minutes/);
  expect(
    screen.queryByText('Coinbase proxy · BRTI access needed for the settlement feed'),
  ).not.toBeInTheDocument();
});

test('distinguishes a fresh BRTI reference from the Coinbase history used while index history is incomplete', async () => {
  const { benchmark } = createMarketFeed(eventStart);
  const view = await renderLiveEstimates({
    feedOverrides: { benchmark: { ...benchmark, samples: benchmark.samples.slice(-61) } },
  });
  await view.user.click(screen.getByText('Settlement estimate details'));
  expect(screen.getByText('BRTI benchmark connected')).toBeVisible();
  expect(getDetailValue('Reference')).toHaveTextContent('$50,000.00 · BRTI');
  expect(getDetailValue('Price history')).toHaveTextContent('Coinbase candles');

  await view.update(eventStart + 1000);
  expect(getDetailValue('Reference')).toHaveTextContent('$50,000.00 · BRTI');
  expect(getDetailValue('Price history')).toHaveTextContent(/BRTI · \d+ complete minutes/);
  expect(getDetailValue('Price history')).toBeVisible();
});

test('shows how observed final-minute readings change the remaining average required for Yes', async () => {
  const view = await renderLiveEstimates({ now: eventEnd - 60_000 });
  await view.user.click(screen.getByText('Settlement estimate details'));
  expect(getDetailValue('Final-minute readings')).toHaveTextContent('0 / 60');
  expect(screen.queryByText('Remaining average for Yes')).not.toBeInTheDocument();

  const halfway = eventEnd - 30_000;
  await view.update(halfway, { benchmark: createFinalMinuteBenchmark(halfway) });
  expect(getDetailValue('Reference')).toHaveTextContent('$50,100.00 · BRTI');
  expect(getDetailValue('Final-minute readings')).toHaveTextContent('30 / 60');
  expect(getDetailValue('Missing elapsed readings')).toHaveTextContent('0');
  // Thirty readings are $50,100; the other thirty need $49,899.99 so that
  // the complete average rounds to the contract's $50,000 Yes threshold.
  expect(getDetailValue('Remaining average for Yes')).toHaveTextContent('$49,899.99');

  const lastTenSeconds = eventEnd - 10_000;
  await view.update(lastTenSeconds, { benchmark: createFinalMinuteBenchmark(lastTenSeconds) });
  expect(getDetailValue('Final-minute readings')).toHaveTextContent('50 / 60');
  expect(getDetailValue('Missing elapsed readings')).toHaveTextContent('0');
  expect(getDetailValue('Remaining average for Yes')).toHaveTextContent('$49,499.97');
});

test('keeps missing elapsed readings explicit and restores the remaining-average calculation when history catches up', async () => {
  const halfway = eventEnd - 30_000;
  const view = await renderLiveEstimates({
    now: halfway,
    feedOverrides: {
      benchmark: createFinalMinuteBenchmark(halfway, {
        missingTimes: [eventEnd - 50_000, eventEnd - 40_000],
      }),
    },
  });
  await view.user.click(screen.getByText('Settlement estimate details'));
  expect(getDetailValue('Final-minute readings')).toHaveTextContent('28 / 60');
  expect(getDetailValue('Missing elapsed readings')).toHaveTextContent('2');
  expect(screen.queryByText('Remaining average for Yes')).not.toBeInTheDocument();
  expect(getDetailValue('Estimated average')).toHaveTextContent(/^\$[\d,]+\.\d{2}$/);

  await view.update(halfway, { benchmark: createFinalMinuteBenchmark(halfway) });
  expect(getDetailValue('Final-minute readings')).toHaveTextContent('30 / 60');
  expect(getDetailValue('Missing elapsed readings')).toHaveTextContent('0');
  expect(getDetailValue('Remaining average for Yes')).toHaveTextContent('$49,899.99');
});
