'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { Alert, Button, Container } from 'react-bootstrap';
import { useGetKalshiMarketsQuery, useGetKalshiBenchmarkQuery } from '@/services/kalshi/kalshi.api';
import useKalshiSettlement from './hooks/useKalshiSettlement';
import useKalshiSchedule from './hooks/useKalshiSchedule';
import { getKalshiContract, KALSHI_OUTCOME_DEFINITION } from './utils/kalshi/contract.utils';
import { createKalshiForecastBatch } from './utils/kalshi/forecastBatch.utils';
import BitcoinPriceSummary from './components/BitcoinPriceSummary';
import TrackerHeader from './components/TrackerHeader';
import Icon from './components/Icon';
import PriceChart from './components/PriceChart';
import { getBenchmarkChartData } from './utils/benchmarkChart.utils';
import MarketData from './components/MarketData';
import ForecastPanel from './components/ForecastPanel';
import ForecastJournal from './components/ForecastJournal';
import Methodology from './components/Methodology';
import useClock from './hooks/useClock';
import useForecastJournal from './hooks/useForecastJournal';
import useForecastPreferences from './hooks/useForecastPreferences';
import useAutomaticKalshiForecast from './hooks/useAutomaticKalshiForecast';
import useFixedPrediction from './hooks/useFixedPrediction';
import useCoinbaseMarketData from './hooks/useCoinbaseMarketData';
import useDerivativesMarketData from './hooks/useDerivativesMarketData';
import { KALSHI_DERIVATIVES_MODEL_VERSION } from './utils/kalshi/forecast.utils';
import useLiveKalshiForecast from './hooks/useLiveKalshiForecast';
import useForecastEvidence from './hooks/useForecastEvidence';
import useResearchSync from './hooks/useResearchSync';
import useResearchLearning from './hooks/useResearchLearning';
import useBackgroundResearch from './hooks/useBackgroundResearch';
import ForecastRisk from './components/ForecastRisk';
import { getResearchForecast } from './utils/researchForecast.utils';
import { createResearchInputSnapshot } from './utils/researchExperiments.utils';
import { KALSHI_CHECKPOINT_POLICY_VERSION } from './utils/fixedPrediction.utils';
import {
  getKalshiMarketConditions,
  getKalshiReferenceQuote,
  hasIndependentKalshiBenchmark,
} from './utils/kalshi/marketConditions.utils';
import {
  forecastBatchRecorded,
  forecastsObserved,
  historyCleared,
  scheduleCreated,
  scheduleCancelled,
} from './state/slices/trackerSlice';
import {
  selectActiveForecast,
  selectLatestForecast,
  selectForecasts,
  selectJournalSummary,
  selectJournalOutcomeGroups,
  selectTrackerState,
  selectScheduledForecast,
} from './state/selectors/trackerSelectors';
import './BitcoinTracker.scss';

const EMPTY_MARKETS = [];

export default function BitcoinTracker() {
  const now = useClock();
  const dispatch = useDispatch();
  const store = useStore();
  const journal = useForecastJournal();
  const isJournalReady = journal.isReady;
  const {
    preferences,
    setAutoEnabled,
    setCheckpointMinutes,
    isRestored: arePreferencesReady,
    warning: preferencesWarning,
  } = useForecastPreferences();
  const [isPreparingForecast, setIsPreparingForecast] = useState(false);
  const [selectedMarketTicker, setSelectedMarketTicker] = useState(null);

  // Load the selected event and its price inputs before calculating any estimates.
  const kalshiQuery = useGetKalshiMarketsQuery(undefined, {
    pollingInterval: 15_000,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  const kalshiMarkets = kalshiQuery.data?.markets ?? EMPTY_MARKETS;
  const scheduledForecast = useSelector(selectScheduledForecast);
  const selectedMarket =
    kalshiMarkets.find(
      (market) =>
        market.ticker ===
          (scheduledForecast?.marketTicker ??
            (preferences.autoEnabled ? null : selectedMarketTicker)) && market.expiresAt > now,
    ) ??
    kalshiMarkets.find((market) => market.expiresAt > now && market.startsAt <= now) ??
    kalshiMarkets.find((market) => market.expiresAt > now) ??
    null;
  const benchmarkQuery = useGetKalshiBenchmarkQuery(selectedMarket?.expiresAt, {
    skip: !selectedMarket,
    pollingInterval: 2000,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  const benchmark = benchmarkQuery.data;
  const benchmarkData = useMemo(() => getBenchmarkChartData(benchmark, now), [benchmark, now]);
  const {
    stream,
    ticker,
    candles,
    quoteAge,
    historyAge,
    hasStreamTicker,
    isQuoteFresh,
    hasQuoteError,
    hasRequestError,
    isLoading,
    isRefreshing,
    refreshMarketData,
  } = useCoinbaseMarketData(now);
  const derivatives = useDerivativesMarketData();
  const forecasts = useSelector(selectForecasts);
  const activeForecast = useSelector(selectActiveForecast);
  const latestForecast = useSelector(selectLatestForecast);
  // Keep the saved call on screen until the user starts preparing another event.
  const recordedForecast =
    activeForecast ??
    (!isPreparingForecast && !scheduledForecast && !preferences.autoEnabled
      ? latestForecast
      : null);
  const kalshiMarket = recordedForecast?.kalshiMarket
    ? (kalshiMarkets.find((market) => market.ticker === recordedForecast.kalshiMarket.ticker) ??
      recordedForecast.kalshiMarket)
    : selectedMarket;
  const forecastDeadline = kalshiMarket?.expiresAt ?? null;
  const eventForecasts = forecasts.filter(
    (entry) => entry.kalshiMarket?.ticker === kalshiMarket?.ticker,
  );
  const riskForecast =
    [...eventForecasts]
      .filter((entry) => Number.isFinite(entry.aboveProbability))
      .sort((left, right) => right.createdAt - left.createdAt)[0] ?? recordedForecast;
  const horizonMinutes =
    forecastDeadline === null ? 15 : Math.min(15, (forecastDeadline - now) / 60_000);
  const summary = useSelector(selectJournalSummary);
  const outcomeGroups = useSelector(selectJournalOutcomeGroups);
  const { storageWarning } = useSelector(selectTrackerState);
  const target = kalshiMarket?.target ?? NaN;
  const displayedTargetInput = Number.isFinite(target) ? target.toFixed(2) : '';

  // Storage cleanup must finish before recording, syncing, or settling saved forecasts.
  const researchSync = useResearchSync({ forecasts, isReady: isJournalReady, now });
  const researchLearning = useResearchLearning({
    isReady: journal.isRestored,
    canReview: isJournalReady,
    now,
  });
  const { models } = researchLearning;
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
    hasContractError: kalshiQuery.isError,
  });
  const kalshiSettlement = useKalshiSettlement({ forecasts, now, isReady: isJournalReady });
  const getResearchEstimate = useCallback(
    ({
      target: forecastTarget,
      now: evaluatedAt,
      expiresAt,
      kalshiMarket: contract,
      benchmark: capturedBenchmark,
      captureResearchInputs = false,
    }) => {
      const input = {
        candles,
        ticker,
        stream,
        derivatives,
        target: forecastTarget,
        now: evaluatedAt,
        expiresAt,
        horizonMinutes: (expiresAt - evaluatedAt) / 60_000,
        kalshiMarket: contract,
        benchmark: capturedBenchmark ?? benchmark,
      };
      const result = getResearchForecast(input, models, expiresAt - 900_000);
      if (captureResearchInputs) {
        result.researchInputSnapshot = createResearchInputSnapshot(
          input,
          models,
          expiresAt - 900_000,
          result,
        );
      }
      return hasRequestError && !hasIndependentKalshiBenchmark(result)
        ? { ...result, available: false, aboveProbability: null, belowProbability: null }
        : result;
    },
    [candles, ticker, stream, derivatives, models, hasRequestError, benchmark],
  );
  const getResearchConditions = useCallback(
    ({ target: forecastTarget, now: evaluatedAt, expiresAt, forecast: estimate }) =>
      getKalshiMarketConditions({
        candles,
        ticker,
        target: forecastTarget,
        now: evaluatedAt,
        horizonMinutes: (expiresAt - evaluatedAt) / 60_000,
        forecast: estimate,
      }),
    [candles, ticker],
  );
  const backgroundResearch = useBackgroundResearch({
    now,
    isReady: isJournalReady,
    ticker,
    stream,
    getEstimate: getResearchEstimate,
    getConditions: getResearchConditions,
    markets: kalshiMarkets,
    benchmark,
  });
  // Live estimates can move; observation and reversal risk remain tied to the saved contract.
  const forecast = useLiveKalshiForecast({
    candles,
    ticker,
    target,
    now,
    hasRequestError,
    forecastDeadline,
    stream,
    derivatives,
    models,
    kalshiMarket,
    benchmark,
    hasContractError: kalshiQuery.isError,
  });
  const fixedProgress = useFixedPrediction({
    forecast: isJournalReady ? activeForecast : null,
    candles,
    ticker,
    now,
    hasRequestError,
    stream,
    derivatives,
    models,
    benchmark,
  });
  const savedRiskEstimate = useMemo(
    () =>
      riskForecast && now
        ? getResearchEstimate({
            target: riskForecast.target,
            expiresAt: riskForecast.expiresAt,
            now: Date.now(),
            kalshiMarket: riskForecast.kalshiMarket,
          })
        : null,
    [riskForecast, now, getResearchEstimate],
  );
  const savedRiskConditions = useMemo(
    () =>
      riskForecast && now
        ? getResearchConditions({
            target: riskForecast.target,
            expiresAt: riskForecast.expiresAt,
            now: Date.now(),
            forecast: savedRiskEstimate,
          })
        : null,
    [riskForecast, now, getResearchConditions, savedRiskEstimate],
  );
  const marketConditions = useMemo(
    () =>
      getKalshiMarketConditions({
        candles,
        ticker,
        target,
        now: now ? Date.now() : now,
        horizonMinutes,
        forecast,
      }),
    [candles, ticker, target, now, horizonMinutes, forecast],
  );
  const evidenceWarning = useForecastEvidence({
    forecasts,
    candles,
    ticker,
    stream,
    derivatives,
    now,
    progress: fixedProgress,
    isReady: isJournalReady,
    models,
    benchmark,
    kalshiOutcomes: kalshiSettlement.outcomes,
  });

  useEffect(() => {
    if (isJournalReady && now && forecasts.length) {
      dispatch(forecastsObserved({ now, kalshiOutcomes: kalshiSettlement.outcomes }));
    }
  }, [dispatch, isJournalReady, now, forecasts, kalshiSettlement.outcomes]);

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
        kalshiQuery.isError ||
        contract.startsAt > createdAt ||
        contract.expiresAt <= createdAt ||
        store
          .getState()
          .tracker.forecasts.some((entry) => entry.kalshiMarket?.ticker === contract.ticker)
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
      const saved = store.getState().tracker;
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
      kalshiQuery.isError,
      getResearchEstimate,
      ticker,
      preferences.checkpointMinutes,
      dispatch,
      store,
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
      kalshiQuery.isError ||
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

  return (
    <div className="bitcoin-tracker">
      <a className="skip-link" href="#main-content">
        Skip to tracker
      </a>
      <main id="main-content" tabIndex="-1">
        <Container fluid className="tracker-container">
          <TrackerHeader
            now={now}
            benchmarkData={benchmarkData}
            hasStreamTicker={hasStreamTicker}
          />
          {hasRequestError && (
            <Alert
              variant="warning"
              className="d-flex align-items-center justify-content-between gap-3"
            >
              <span>
                {hasIndependentKalshiBenchmark(forecast)
                  ? 'Coinbase data is reconnecting. BRTI-based estimates remain available.'
                  : 'Market data is temporarily unavailable. Estimates are paused while we reconnect.'}
                {recordedForecast &&
                  (['analyzing', 'withheld'].includes(recordedForecast.status)
                    ? ' The saved target and end time are retained.'
                    : ' The fixed prediction is retained.')}
              </span>
              <Button
                variant="outline-secondary"
                size="sm"
                className="flex-shrink-0"
                disabled={isRefreshing}
                onClick={refreshMarketData}
              >
                <Icon name="refresh" size={15} /> Retry
              </Button>
            </Alert>
          )}
          {storageWarning && <Alert variant="warning">{storageWarning}</Alert>}
          {kalshiSettlement.warning && <Alert variant="warning">{kalshiSettlement.warning}</Alert>}
          <div className="tracker-workspace">
            <div className="market-panel dashboard-panel">
              <BitcoinPriceSummary benchmarkData={benchmarkData} />
              <PriceChart
                benchmarkData={benchmarkData}
                forecast={forecast}
                target={target}
                now={now}
                deadline={forecastDeadline}
              />
            </div>
            <ForecastPanel
              targetInput={displayedTargetInput}
              ticker={isQuoteFresh && !hasQuoteError ? ticker : null}
              forecast={forecast}
              fixedProgress={fixedProgress}
              forecastDeadline={forecastDeadline}
              activeForecast={activeForecast}
              eventForecasts={eventForecasts}
              isPreparingForecast={isPreparingForecast}
              autoEnabled={preferences.autoEnabled}
              onAutoEnabledChange={setAutoEnabled}
              checkpointMinutes={preferences.checkpointMinutes}
              onCheckpointMinutesChange={setCheckpointMinutes}
              isJournalOwner={journal.isOwner}
              preferencesWarning={preferencesWarning ?? automaticForecast.warning}
              recordedForecast={recordedForecast}
              now={now}
              onRecord={recordForecast}
              onNewForecast={prepareForecast}
              scheduledForecast={scheduledForecast}
              onSchedule={scheduleForecast}
              onCancelSchedule={() => {
                if (isJournalReady) dispatch(scheduleCancelled());
              }}
              isJournalReady={isJournalReady}
              isLoading={isLoading && !forecast.available}
              riskControl={
                riskForecast ? (
                  <ForecastRisk
                    forecast={savedRiskEstimate}
                    fixedForecast={riskForecast}
                    ticker={ticker}
                    now={now}
                    stream={stream}
                    conditions={savedRiskConditions}
                  />
                ) : null
              }
              kalshi={{
                market: kalshiMarket,
                markets: kalshiMarkets,
                onSelect: setSelectedMarketTicker,
                error: kalshiQuery.isError,
                benchmark,
              }}
            />
            <MarketData
              ticker={ticker}
              quoteAge={quoteAge}
              isQuoteFresh={isQuoteFresh}
              historyAge={historyAge}
              forecast={forecast}
              stream={stream}
              derivatives={derivatives}
              conditions={marketConditions}
            />
            <ForecastJournal
              forecasts={forecasts}
              summary={summary}
              outcomeGroups={outcomeGroups}
              now={now}
              onClear={() => {
                if (isJournalReady) dispatch(historyCleared());
              }}
            />
            <Methodology
              evidenceWarning={
                evidenceWarning ??
                researchSync.warning ??
                backgroundResearch.warning ??
                researchLearning.warning
              }
              researchStatus={{ ...researchSync, background: backgroundResearch.status }}
            />
          </div>
        </Container>
      </main>
    </div>
  );
}
