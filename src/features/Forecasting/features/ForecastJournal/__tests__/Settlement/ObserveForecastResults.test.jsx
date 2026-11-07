import { screen, within } from '@testing-library/react';
import {
  renderForecastJournal,
  setSettlementFailure,
  setSettlementResponse,
  setupJournalTests,
} from '../helpers/journalTestHarness';
import { createSavedForecast, createSettledMarket, journalNow } from '../helpers/journalFixtures';
import { getCheckpointRow, openHistory } from './helpers/historyQueries';

setupJournalTests();

describe('Observing official forecast results', () => {
  test('follows a saved call from its countdown through a delayed result, then retains the result after reload', async () => {
    const forecast = createSavedForecast({
      id: 'pending-call',
      status: 'pending',
      startsAt: journalNow,
    });
    setSettlementFailure(forecast.kalshiMarket.ticker, new Error('The result is delayed.'));
    const view = await renderForecastJournal({ forecasts: [forecast], now: journalNow + 600_000 });
    let history = await openHistory(view.user);
    expect(getCheckpointRow(history, 9)).toHaveTextContent('05:00');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('80.0% / 20.0%');
    expect(history.queryByText('Official Kalshi settlement')).not.toBeInTheDocument();

    await view.update(forecast.expiresAt);
    expect(getCheckpointRow(history, 9)).toHaveTextContent('Awaiting Kalshi');
    expect(
      await screen.findByText('Kalshi results are delayed. Saved forecasts will be checked again.'),
    ).toBeVisible();
    expect(history.getByText('Scored:')).toHaveTextContent('Scored: 0');

    setSettlementResponse(
      createSettledMarket(forecast, {
        settlementPrice: 50_100,
        receivedAt: forecast.expiresAt + 15_000,
      }),
    );
    await view.update(forecast.expiresAt + 15_000);
    expect(await history.findByText('Correct', { exact: true })).toBeVisible();
    expect(getCheckpointRow(history, 9)).toHaveTextContent('$50,100.00');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('Official Kalshi settlement');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('80.0% / 20.0%');
    expect(history.getByText('Scored:')).toHaveTextContent('Scored: 1');
    expect(history.getByText('Observed accuracy:')).toHaveTextContent('100.0%');
    expect(history.getByText('Brier:')).toHaveTextContent('0.040');
    expect(
      screen.queryByText('Kalshi results are delayed. Saved forecasts will be checked again.'),
    ).not.toBeInTheDocument();

    // A later API snapshot must not rewrite a result already observed in this browser.
    setSettlementResponse(
      createSettledMarket(forecast, {
        result: 'no',
        settlementPrice: 49_900,
        receivedAt: forecast.expiresAt + 30_000,
      }),
    );
    await view.update(forecast.expiresAt + 30_000);
    expect(getCheckpointRow(history, 9)).toHaveTextContent('Correct');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('$50,100.00');
    await view.reload();
    history = await openHistory(view.user);
    expect(getCheckpointRow(history, 9)).toHaveTextContent('Correct');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('$50,100.00');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('80.0% / 20.0%');
  });

  test('settles separate fixed calls against the same official tie without changing their probabilities', async () => {
    const yesCall = createSavedForecast({
      id: 'yes-call',
      status: 'pending',
      startsAt: journalNow,
      checkpointMinutes: 12,
      aboveProbability: 0.8,
    });
    const noCall = createSavedForecast({
      id: 'no-call',
      status: 'pending',
      startsAt: journalNow,
      checkpointMinutes: 9,
      aboveProbability: 0.2,
    });
    const neutralCall = createSavedForecast({
      id: 'neutral-call',
      status: 'pending',
      startsAt: journalNow,
      checkpointMinutes: 6,
      aboveProbability: 0.5,
    });
    const view = await renderForecastJournal({
      forecasts: [yesCall, noCall, neutralCall],
      now: journalNow + 600_000,
    });
    const history = await openHistory(view.user);
    expect(getCheckpointRow(history, 12)).toHaveTextContent('80.0% / 20.0%');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('20.0% / 80.0%');
    expect(getCheckpointRow(history, 6)).toHaveTextContent('50.0% / 50.0%');

    setSettlementResponse(
      createSettledMarket(yesCall, {
        result: 'yes',
        settlementPrice: yesCall.target,
        receivedAt: yesCall.expiresAt,
      }),
    );
    await view.update(yesCall.expiresAt);
    expect(await history.findByText('Correct', { exact: true })).toBeVisible();
    expect(getCheckpointRow(history, 12)).toHaveTextContent('Correct');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('Incorrect');
    expect(getCheckpointRow(history, 6)).toHaveTextContent('Neutral · unscored');
    expect(history.getAllByText('Official Kalshi settlement')).toHaveLength(3);
    expect(history.getByText('Scored:')).toHaveTextContent('Scored: 2');
    expect(history.getByText('Observed accuracy:')).toHaveTextContent('50.0%');
    expect(history.getByText('Brier:')).toHaveTextContent('0.310');
    expect(getCheckpointRow(history, 12)).toHaveTextContent('80.0% / 20.0%');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('20.0% / 80.0%');
    expect(getCheckpointRow(history, 6)).toHaveTextContent('50.0% / 50.0%');
  });

  test('keeps an uncaptured checkpoint unscored when another call receives the official result', async () => {
    const withheld = createSavedForecast({
      id: 'uncaptured-call',
      status: 'withheld',
      startsAt: journalNow,
      checkpointMinutes: 9,
    });
    const issued = createSavedForecast({
      id: 'issued-call',
      status: 'pending',
      startsAt: journalNow,
      checkpointMinutes: 6,
    });
    const view = await renderForecastJournal({
      forecasts: [withheld, issued],
      now: journalNow + 600_000,
    });
    const history = await openHistory(view.user);
    expect(getCheckpointRow(history, 9)).toHaveTextContent('Not issued');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('No call · unscored');

    setSettlementResponse(createSettledMarket(issued));
    await view.update(issued.expiresAt);
    expect(await history.findByText('Correct', { exact: true })).toBeVisible();
    expect(getCheckpointRow(history, 9)).toHaveTextContent('Not issued');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('No call · unscored');
    expect(
      within(getCheckpointRow(history, 9)).queryByText('Official Kalshi settlement'),
    ).not.toBeInTheDocument();
    expect(getCheckpointRow(history, 6)).toHaveTextContent('Correct');
    expect(history.getByText('No calls:')).toHaveTextContent('No calls: 1');
    expect(history.getByText('Call coverage:')).toHaveTextContent('50.0%');
    expect(history.getByText('Scored:')).toHaveTextContent('Scored: 1');
    expect(history.getByText('Observed accuracy:')).toHaveTextContent('100.0%');
    expect(history.getByText('Brier:')).toHaveTextContent('0.040');
  });

  test('resumes checking a saved unfinished result after the user reloads', async () => {
    const forecast = createSavedForecast({
      id: 'reconnected-call',
      status: 'pending',
      startsAt: journalNow,
      aboveProbability: 0.2,
    });
    const now = forecast.expiresAt + 60_000;
    setSettlementFailure(forecast.kalshiMarket.ticker, new Error('Offline'));
    const view = await renderForecastJournal({ forecasts: [forecast], now });
    let history = await openHistory(view.user);
    expect(getCheckpointRow(history, 9)).toHaveTextContent('Awaiting Kalshi');
    expect(
      await screen.findByText('Kalshi results are delayed. Saved forecasts will be checked again.'),
    ).toBeVisible();

    setSettlementResponse(
      createSettledMarket(forecast, { result: 'no', settlementPrice: 49_900, receivedAt: now }),
    );
    await view.reload();
    history = await openHistory(view.user);
    expect(await history.findByText('Correct', { exact: true })).toBeVisible();
    expect(getCheckpointRow(history, 9)).toHaveTextContent('20.0% / 80.0%');
    expect(getCheckpointRow(history, 9)).toHaveTextContent('$49,900.00');
    expect(history.queryByText('Awaiting Kalshi')).not.toBeInTheDocument();
  });

  test.each([
    ['an event that is only closed', { status: 'closed' }],
    ['a different contract', { ticker: 'KXBTC15M-OTHER-EVENT' }],
    ['a different target', { target: 50_010 }],
    ['an unverified contract', { rulesVerified: false }],
    ['an unsupported result', { result: 'unknown' }],
    ['a response from before close', { receivedAt: journalNow + 899_999 }],
    ['a response from the future', { receivedAt: journalNow + 930_000 }],
  ])(
    'keeps a saved call awaiting a verified result when the API returns %s',
    async (_, marketChanges) => {
      const forecast = createSavedForecast({
        id: 'verified-result-call',
        status: 'pending',
        startsAt: journalNow,
      });
      const now = forecast.expiresAt + 15_000;
      const validMarket = createSettledMarket(forecast, {
        settlementPrice: 50_100,
        receivedAt: now,
      });
      // The remote lookup still serves this response for the requested ticker.
      setSettlementResponse({ ...validMarket, ...marketChanges }, forecast.kalshiMarket.ticker);
      const view = await renderForecastJournal({ forecasts: [forecast], now });
      const history = await openHistory(view.user);
      expect(getCheckpointRow(history, 9)).toHaveTextContent('Awaiting Kalshi');
      expect(getCheckpointRow(history, 9)).toHaveTextContent('80.0% / 20.0%');
      expect(history.queryByText('Official Kalshi settlement')).not.toBeInTheDocument();
      expect(history.getByText('Scored:')).toHaveTextContent('Scored: 0');

      setSettlementResponse({ ...validMarket, receivedAt: now + 15_000 });
      await view.update(now + 15_000);
      expect(await history.findByText('Correct', { exact: true })).toBeVisible();
      expect(getCheckpointRow(history, 9)).toHaveTextContent('$50,100.00');
      expect(history.getByText('Scored:')).toHaveTextContent('Scored: 1');
    },
  );

  test('shows an available result while another event retries and later resolves independently', async () => {
    const firstForecast = createSavedForecast({
      id: 'older-call',
      status: 'awaiting-settlement',
      startsAt: journalNow - 1_800_000,
      target: 49_000,
    });
    const secondForecast = createSavedForecast({
      id: 'recent-call',
      status: 'awaiting-settlement',
      startsAt: journalNow - 900_000,
      target: 51_000,
      aboveProbability: 0.2,
    });
    setSettlementFailure(firstForecast.kalshiMarket.ticker, new Error('First result is delayed.'));
    setSettlementResponse(
      createSettledMarket(secondForecast, {
        result: 'no',
        settlementPrice: 50_900,
        receivedAt: journalNow,
      }),
    );
    const view = await renderForecastJournal({
      forecasts: [firstForecast, secondForecast],
      now: journalNow,
    });
    const history = await openHistory(view.user);
    expect(await history.findByText('Correct', { exact: true })).toBeVisible();
    const olderRow = history.getByRole('row', { name: /\$49,000\.00/ });
    const recentRow = history.getByRole('row', { name: /\$51,000\.00/ });
    expect(olderRow).toHaveTextContent('Awaiting Kalshi');
    expect(recentRow).toHaveTextContent('Correct');
    expect(history.getByText('Scored:')).toHaveTextContent('Scored: 1');
    expect(
      await screen.findByText('Kalshi results are delayed. Saved forecasts will be checked again.'),
    ).toBeVisible();

    setSettlementResponse(
      createSettledMarket(firstForecast, {
        result: 'yes',
        settlementPrice: 49_100,
        receivedAt: journalNow + 15_000,
      }),
    );
    await view.update(journalNow + 15_000);
    expect(await within(olderRow).findByText('Correct', { exact: true })).toBeVisible();
    expect(recentRow).toHaveTextContent('Correct');
    expect(history.getByText('Scored:')).toHaveTextContent('Scored: 2');
    expect(history.getByText('Observed accuracy:')).toHaveTextContent('100.0%');
    expect(
      screen.queryByText('Kalshi results are delayed. Saved forecasts will be checked again.'),
    ).not.toBeInTheDocument();
  });
});
