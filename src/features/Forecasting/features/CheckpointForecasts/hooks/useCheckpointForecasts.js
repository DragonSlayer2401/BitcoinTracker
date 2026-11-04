import { useCallback } from 'react';
import { useDispatch, useStore } from 'react-redux';
import useAutomaticKalshiForecast from './useAutomaticKalshiForecast';
import useFixedPrediction from './useFixedPrediction';
import useKalshiSchedule from './useKalshiSchedule';
import { createKalshiForecastBatch } from '../utils/kalshi/forecastBatch.utils';
import { KALSHI_CHECKPOINT_POLICY_VERSION } from '../utils/fixedPrediction.utils';
import {
  selectForecasts,
  selectForecastState,
} from '@/features/Forecasting/state/selectors/forecastSelectors';
import {
  forecastBatchRecorded,
  scheduleCreated,
  scheduleCancelled,
} from '@/features/Forecasting/state/slices/forecastSlice';
import {
  getKalshiContract,
  KALSHI_OUTCOME_DEFINITION,
} from '@/features/MarketData/utils/kalshi/contract.utils';
import { KALSHI_DERIVATIVES_MODEL_VERSION } from '@/features/Forecasting/features/LiveEstimates/utils/kalshi/forecast.utils';
import { getKalshiReferenceQuote } from '@/features/Forecasting/features/LiveEstimates/utils/kalshi/marketConditions.utils';

const useCheckpointForecasts = ({
  now,
  selection,
  marketData,
  kalshiMarket,
  isJournalReady,
  research,
}) => {
  const dispatch = useDispatch();
  const store = useStore();
  const {
    activeForecast,
    scheduledForecast,
    controls,
    forecasts,
    setIsPreparingForecast,
    setSelectedMarketTicker,
  } = selection;
  const { preferences, isRestored: arePreferencesReady } = controls;
  const {
    kalshiMarkets,
    candles,
    ticker,
    stream,
    derivatives,
    benchmark,
    hasRequestError,
    hasContractError,
  } = marketData;
  const { models, getResearchEstimate } = research;
  useKalshiSchedule({
    markets: kalshiMarkets,
    ticker,
    candles,
    stream,
    derivatives,
    models,
    benchmark,
    now,
    isReady: isJournalReady,
    hasRequestError,
    hasContractError,
  });
  const fixedProgress = useFixedPrediction({
    forecast: isJournalReady ? activeForecast : null,
    kalshiMarket,
    candles,
    ticker,
    now,
    hasRequestError,
    stream,
    derivatives,
    models,
    benchmark,
  });
  // User actions start observation now or arm a future event by its official identity.
  const prepareForecast = () => {
    setIsPreparingForecast(true);
    const next = kalshiMarkets.find(
      (market) =>
        market.expiresAt > now &&
        !forecasts.some((entry) => entry.kalshiMarket?.ticker === market.ticker),
    );
    setSelectedMarketTicker(next?.ticker ?? null);
  };
  const startEvent = useCallback(
    (contract, captureOrigin = 'manual') => {
      const createdAt = Date.now();
      if (
        activeForecast ||
        !isJournalReady ||
        !arePreferencesReady ||
        scheduledForecast?.status === 'scheduled'
      )
        return false;
      if (
        !contract ||
        hasContractError ||
        contract.startsAt > createdAt ||
        contract.expiresAt <= createdAt ||
        selectForecasts(store.getState()).some(
          (entry) => entry.kalshiMarket?.ticker === contract.ticker,
        )
      ) {
        return false;
      }
      const estimate = getResearchEstimate({
        target: contract.target,
        now: createdAt,
        expiresAt: contract.expiresAt,
        kalshiMarket: contract,
      });
      const reference = getKalshiReferenceQuote(estimate, ticker);
      if (
        !estimate.available ||
        !reference ||
        reference.time < contract.startsAt ||
        reference.receivedAt < contract.startsAt
      )
        return false;
      const batch = createKalshiForecastBatch({
        id: crypto.randomUUID(),
        checkpointMinutes: preferences.checkpointMinutes,
        captureOrigin,
        contract,
        createdAt,
        price: reference.price,
        modelVersion: KALSHI_DERIVATIVES_MODEL_VERSION,
      });
      if (!batch) return false;
      dispatch(forecastBatchRecorded(batch));
      const saved = selectForecastState(store.getState());
      if (
        saved.storageWarning ||
        !batch.every((entry) => saved.forecasts.some((record) => record.id === entry.id))
      )
        return false;
      setSelectedMarketTicker(contract.ticker);
      setIsPreparingForecast(false);
      return true;
    },
    [
      activeForecast,
      isJournalReady,
      arePreferencesReady,
      scheduledForecast,
      hasContractError,
      getResearchEstimate,
      ticker,
      preferences.checkpointMinutes,
      dispatch,
      store,
      setIsPreparingForecast,
      setSelectedMarketTicker,
    ],
  );
  const automaticForecast = useAutomaticKalshiForecast({
    enabled: preferences.autoEnabled,
    isReady: isJournalReady && arePreferencesReady,
    markets: kalshiMarkets,
    forecasts,
    scheduledForecast,
    now,
    onStartEvent: useCallback((contract) => startEvent(contract, 'automatic'), [startEvent]),
  });
  const recordForecast = () => startEvent(getKalshiContract(kalshiMarket));

  const scheduleForecast = () => {
    const createdAt = Date.now();
    if (
      !isJournalReady ||
      activeForecast ||
      scheduledForecast ||
      !kalshiMarket?.rulesVerified ||
      hasContractError ||
      kalshiMarket.startsAt <= createdAt
    ) {
      return;
    }
    dispatch(
      scheduleCreated({
        id: crypto.randomUUID(),
        createdAt,
        startsAt: kalshiMarket.startsAt,
        expiresAt: kalshiMarket.expiresAt,
        target: null,
        status: 'scheduled',
        marketTicker: kalshiMarket.ticker,
        eventTicker: kalshiMarket.eventTicker,
        outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
        policyVersion: KALSHI_CHECKPOINT_POLICY_VERSION,
        checkpointMinutes: preferences.checkpointMinutes,
        captureOrigin: 'manual',
      }),
    );
    setIsPreparingForecast(false);
  };
  const cancelSchedule = () => {
    if (isJournalReady) dispatch(scheduleCancelled());
  };

  return {
    fixedProgress,
    recordForecast,
    prepareForecast,
    scheduleForecast,
    cancelSchedule,
    warning: automaticForecast.warning,
  };
};
export default useCheckpointForecasts;
