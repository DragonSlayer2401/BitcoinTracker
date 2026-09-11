import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { selectScheduledForecast } from '../state/selectors/trackerSelectors';
import { scheduledForecastStarted, scheduleStartMissed } from '../state/slices/trackerSlice';
import { getKalshiContract, KALSHI_OUTCOME_DEFINITION } from '../utils/kalshi/contract.utils';
import { KALSHI_MODEL_VERSION } from '../utils/kalshi/forecast.utils';
import { getFixedForecastAnalysis, KALSHI_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import { getResearchForecast } from '../utils/researchForecast.utils';
import {
  getKalshiReferenceQuote,
  hasIndependentKalshiBenchmark,
} from '../utils/kalshi/marketConditions.utils';

// Future events are armed by identity. Their official target is read only after
// opening; reconnecting later uses the same deadline and a shorter observation.
export default function useKalshiSchedule({
  markets,
  ticker,
  candles,
  stream,
  models,
  benchmark,
  now,
  isReady,
  hasRequestError,
  hasContractError = false,
}) {
  const dispatch = useDispatch();
  const schedule = useSelector(selectScheduledForecast);
  useEffect(() => {
    if (
      !isReady ||
      !now ||
      schedule?.status !== 'scheduled' ||
      schedule.outcomeDefinition !== KALSHI_OUTCOME_DEFINITION
    )
      return;
    const capturedAt = Date.now();
    if (capturedAt < schedule.startsAt) return;
    if (capturedAt > schedule.expiresAt - 20_000) {
      dispatch(scheduleStartMissed({ now: capturedAt }));
      return;
    }
    const market = markets?.find((entry) => entry.ticker === schedule.marketTicker);
    const contract = getKalshiContract(market);
    if (
      !contract ||
      contract.eventTicker !== schedule.eventTicker ||
      contract.startsAt !== schedule.startsAt ||
      contract.expiresAt !== schedule.expiresAt ||
      !['active', 'open'].includes(market.status) ||
      hasContractError ||
      (!benchmark?.available &&
        (hasRequestError ||
          !ticker ||
          ticker.time < schedule.startsAt ||
          ticker.receivedAt < schedule.startsAt))
    )
      return;
    const estimate = getResearchForecast(
      {
        candles,
        ticker,
        stream,
        now: capturedAt,
        target: contract.target,
        expiresAt: contract.expiresAt,
        horizonMinutes: (contract.expiresAt - capturedAt) / 60_000,
        kalshiMarket: contract,
        benchmark,
      },
      models,
      contract.startsAt,
    );
    const reference = getKalshiReferenceQuote(estimate, ticker);
    if (
      !estimate.available ||
      (hasRequestError && !hasIndependentKalshiBenchmark(estimate)) ||
      !reference ||
      reference.time < schedule.startsAt ||
      reference.receivedAt < schedule.startsAt
    )
      return;
    dispatch(
      scheduledForecastStarted({
        now: capturedAt,
        forecast: {
          id: schedule.id,
          createdAt: capturedAt,
          startsAt: contract.startsAt,
          timingMode: 'end',
          expiresAt: contract.expiresAt,
          price: reference.price,
          target: contract.target,
          aboveProbability: null,
          belowProbability: null,
          direction: 'neutral',
          modelVersion: KALSHI_MODEL_VERSION,
          status: 'analyzing',
          calculationMode: null,
          analysis: getFixedForecastAnalysis({
            startedAt: capturedAt,
            expiresAt: contract.expiresAt,
            policyVersion: KALSHI_POLICY_VERSION,
          }),
          outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
          kalshiMarket: contract,
          kalshi: null,
        },
      }),
    );
  }, [
    markets,
    ticker,
    candles,
    stream,
    models,
    benchmark,
    now,
    isReady,
    hasRequestError,
    hasContractError,
    schedule,
    dispatch,
  ]);
}
