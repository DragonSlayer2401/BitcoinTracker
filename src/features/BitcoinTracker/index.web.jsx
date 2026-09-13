'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Alert, Button, Container } from 'react-bootstrap';
import { useGetKalshiMarketsQuery, useGetKalshiBenchmarkQuery } from '@/services/kalshi/kalshi.api';
import useKalshiSettlement from './hooks/useKalshiSettlement';
import useKalshiSchedule from './hooks/useKalshiSchedule';
import { getKalshiContract, KALSHI_OUTCOME_DEFINITION } from './utils/kalshi/contract.utils';
import { createKalshiForecastRecord } from './utils/kalshi/forecastRecord.utils';
import BitcoinPriceSummary from './components/BitcoinPriceSummary';
import TrackerHeader from './components/TrackerHeader';
import Icon from './components/Icon';
import PriceChart from './components/PriceChart';
import MarketData from './components/MarketData';
import ForecastPanel from './components/ForecastPanel';
import ForecastJournal from './components/ForecastJournal';
import Methodology from './components/Methodology';
import useClock from './hooks/useClock';
import useForecastJournal from './hooks/useForecastJournal';
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
import { KALSHI_POLICY_VERSION } from './utils/fixedPrediction.utils';
import {
  getKalshiMarketConditions,
  getKalshiReferenceQuote,
  hasIndependentKalshiBenchmark,
} from './utils/kalshi/marketConditions.utils';
import {
  forecastRecorded,
  forecastsObserved,
  historyCleared,
  scheduleCreated,
  scheduleCancelled,
} from './state/slices/trackerSlice';
import {
  selectActiveForecast,
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
  const isJournalReady = useForecastJournal();
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
      (market) => market.ticker === (scheduledForecast?.marketTicker ?? selectedMarketTicker),
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
  const {
    stream,
    ticker,
    candles,
    quoteAge,
    historyAge,
    priceChange,
    hasStreamTicker,
    isQuoteFresh,
    isFeedFresh,
    hasQuoteError,
    hasRequestError,
    isLoading,
    isRefreshing,
    feedStatusLabel,
    refreshMarketData,
  } = useCoinbaseMarketData(now);
  const derivatives = useDerivativesMarketData();
  const forecasts = useSelector(selectForecasts);
  const activeForecast = useSelector(selectActiveForecast);
  // Keep the saved call on screen until the user starts preparing another event.
  const recordedForecast =
    activeForecast ?? (!isPreparingForecast && !scheduledForecast ? (forecasts[0] ?? null) : null);
  const kalshiMarket = recordedForecast?.kalshiMarket
    ? (kalshiMarkets.find((market) => market.ticker === recordedForecast.kalshiMarket.ticker) ??
      recordedForecast.kalshiMarket)
    : selectedMarket;
  const forecastDeadline = kalshiMarket?.expiresAt ?? null;
  const horizonMinutes =
    forecastDeadline === null ? 15 : Math.min(15, (forecastDeadline - now) / 60_000);
  const summary = useSelector(selectJournalSummary);
  const outcomeGroups = useSelector(selectJournalOutcomeGroups);
  const { storageWarning } = useSelector(selectTrackerState);
  const target = kalshiMarket?.target ?? NaN;
  const displayedTargetInput = Number.isFinite(target) ? target.toFixed(2) : '';

  // Storage cleanup must finish before recording, syncing, or settling saved forecasts.
  const researchSync = useResearchSync({ forecasts, isReady: isJournalReady, now });
  const researchLearning = useResearchLearning({ isReady: isJournalReady, now });
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
    }) => {
      const result = getResearchForecast(
        {
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
        },
        models,
        expiresAt - 900_000,
      );
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
      recordedForecast && now
        ? getResearchEstimate({
            target: recordedForecast.target,
            expiresAt: recordedForecast.expiresAt,
            now: Date.now(),
            kalshiMarket: recordedForecast.kalshiMarket,
          })
        : null,
    [recordedForecast, now, getResearchEstimate],
  );
  const savedRiskConditions = useMemo(
    () =>
      recordedForecast && now
        ? getResearchConditions({
            target: recordedForecast.target,
            expiresAt: recordedForecast.expiresAt,
            now: Date.now(),
            forecast: savedRiskEstimate,
          })
        : null,
    [recordedForecast, now, getResearchConditions, savedRiskEstimate],
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
    setSelectedMarketTicker(null);
  };
  const recordForecast = () => {
    const createdAt = Date.now();
    if (activeForecast || !isJournalReady) return;
    const contract = getKalshiContract(kalshiMarket);
    if (
      !contract ||
      kalshiQuery.isError ||
      contract.startsAt > createdAt ||
      contract.expiresAt <= createdAt
    ) {
      return;
    }
    const estimate = getResearchEstimate({
      target: contract.target,
      now: createdAt,
      expiresAt: contract.expiresAt,
      kalshiMarket: contract,
    });
    if (!estimate.available) return;
    dispatch(
      forecastRecorded(
        createKalshiForecastRecord({
          id: crypto.randomUUID(),
          contract,
          createdAt,
          price: getKalshiReferenceQuote(estimate, ticker).price,
          modelVersion: KALSHI_DERIVATIVES_MODEL_VERSION,
        }),
      ),
    );
    setIsPreparingForecast(false);
  };

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
        policyVersion: KALSHI_POLICY_VERSION,
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
            isFeedFresh={isFeedFresh}
            feedStatusLabel={feedStatusLabel}
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
              <BitcoinPriceSummary
                ticker={ticker}
                isQuoteFresh={isQuoteFresh}
                priceChange={priceChange}
              />
              <PriceChart
                candles={candles}
                ticker={ticker}
                forecast={forecast}
                target={target}
                now={now}
                horizonMinutes={horizonMinutes}
              />
            </div>
            <ForecastPanel
              targetInput={displayedTargetInput}
              ticker={isQuoteFresh && !hasQuoteError ? ticker : null}
              forecast={forecast}
              fixedProgress={fixedProgress}
              forecastDeadline={forecastDeadline}
              activeForecast={activeForecast}
              recordedForecast={recordedForecast}
              now={now}
              onRecord={recordForecast}
              onNewForecast={prepareForecast}
              scheduledForecast={scheduledForecast}
              onSchedule={scheduleForecast}
              onCancelSchedule={() => dispatch(scheduleCancelled())}
              isJournalReady={isJournalReady}
              isLoading={isLoading && !forecast.available}
              riskControl={
                recordedForecast ? (
                  <ForecastRisk
                    forecast={savedRiskEstimate}
                    fixedForecast={recordedForecast}
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
              onClear={() => dispatch(historyCleared())}
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
