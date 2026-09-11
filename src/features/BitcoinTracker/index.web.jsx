'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Alert, Button, Container } from 'react-bootstrap';
import { useGetCandlesQuery, useGetTickerQuery } from '@/services/coinbase/coinbase.api';
import { useGetKalshiMarketsQuery, useGetKalshiBenchmarkQuery } from '@/services/kalshi/kalshi.api';
import useKalshiSettlement from './hooks/useKalshiSettlement';
import useKalshiSchedule from './hooks/useKalshiSchedule';
import { getKalshiContract, KALSHI_OUTCOME_DEFINITION } from './utils/kalshi/contract.utils';
import { KALSHI_MODEL_VERSION } from './utils/kalshi/forecast.utils';
import Icon from './components/Icon';
import PriceChart from './components/PriceChart';
import MarketData from './components/MarketData';
import ForecastPanel from './components/ForecastPanel';
import ForecastJournal from './components/ForecastJournal';
import Methodology from './components/Methodology';
import useClock from './hooks/useClock';
import useForecastJournal from './hooks/useForecastJournal';
import useFixedPrediction from './hooks/useFixedPrediction';
import useCoinbaseStream from './hooks/useCoinbaseStream';
import useForecastEvidence from './hooks/useForecastEvidence';
import useResearchSync from './hooks/useResearchSync';
import useResearchLearning from './hooks/useResearchLearning';
import useBackgroundResearch from './hooks/useBackgroundResearch';
import ForecastRisk from './components/ForecastRisk';
import { getResearchForecast } from './utils/researchForecast.utils';
import { getFixedForecastAnalysis, KALSHI_POLICY_VERSION } from './utils/fixedPrediction.utils';
import {
  getKalshiMarketConditions,
  getKalshiReferenceQuote,
  hasIndependentKalshiBenchmark,
} from './utils/kalshi/marketConditions.utils';
import { formatPercent, formatPrice, formatTime } from './utils/format.utils';
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

const EMPTY_CANDLES = [];

export default function BitcoinTracker() {
  const now = useClock();
  const dispatch = useDispatch();
  const isJournalReady = useForecastJournal();
  const [isPreparingForecast, setIsPreparingForecast] = useState(false);
  const [selectedMarketTicker, setSelectedMarketTicker] = useState(null);
  const kalshiQuery = useGetKalshiMarketsQuery(undefined, {
    pollingInterval: 15_000,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  const kalshiMarkets = kalshiQuery.data?.markets ?? EMPTY_CANDLES;
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
  const stream = useCoinbaseStream();
  const quoteQuery = useGetTickerQuery(undefined, {
    pollingInterval: 5000,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  const candleQuery = useGetCandlesQuery(undefined, {
    pollingInterval: 60_000,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });
  // REST keeps estimates available while the execution stream reconnects or gathers history.
  const hasStreamTicker = stream.ticker && now - stream.ticker.receivedAt <= 5000;
  const ticker = hasStreamTicker ? stream.ticker : quoteQuery.data;
  const candles = candleQuery.data || EMPTY_CANDLES;
  const forecasts = useSelector(selectForecasts);
  const activeForecast = useSelector(selectActiveForecast);
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
  const quoteAge = ticker && now ? now - ticker.time : null;
  const isQuoteFresh =
    quoteAge !== null &&
    quoteAge <= 20_000 &&
    quoteAge >= -5000 &&
    now - ticker.receivedAt <= 20_000 &&
    now - ticker.receivedAt >= -5000;
  const hasQuoteError = !hasStreamTicker && quoteQuery.isError;
  const hasRequestError = hasQuoteError || candleQuery.isError;
  const isLoading = (!hasStreamTicker && quoteQuery.isLoading) || candleQuery.isLoading;
  const researchSync = useResearchSync({ forecasts, isReady: isJournalReady, now });
  const researchLearning = useResearchLearning({ isReady: isJournalReady, now });
  const { models } = researchLearning;
  useKalshiSchedule({
    markets: kalshiMarkets,
    ticker,
    candles,
    stream,
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
      target: savedPrice,
      now: timestamp,
      expiresAt,
      kalshiMarket: contract,
      benchmark: reference,
    }) => {
      const result = getResearchForecast(
        {
          candles,
          ticker,
          stream,
          target: savedPrice,
          now: timestamp,
          expiresAt,
          horizonMinutes: (expiresAt - timestamp) / 60_000,
          kalshiMarket: contract,
          benchmark: reference ?? benchmark,
        },
        models,
        expiresAt - 900_000,
      );
      return hasRequestError && !hasIndependentKalshiBenchmark(result)
        ? { ...result, available: false, aboveProbability: null, belowProbability: null }
        : result;
    },
    [candles, ticker, stream, models, hasRequestError, benchmark],
  );
  const getResearchConditions = useCallback(
    ({ target: savedPrice, now: timestamp, expiresAt, forecast: estimate }) =>
      getKalshiMarketConditions({
        candles,
        ticker,
        target: savedPrice,
        now: timestamp,
        horizonMinutes: (expiresAt - timestamp) / 60_000,
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
  const forecast = useMemo(() => {
    const evaluatedAt = now ? Date.now() : now;
    const estimate = getResearchForecast(
      {
        candles,
        ticker,
        target,
        now: evaluatedAt,
        stream,
        kalshiMarket,
        benchmark,
        expiresAt: forecastDeadline ?? undefined,
        horizonMinutes:
          forecastDeadline === null ? 15 : Math.min(15, (forecastDeadline - evaluatedAt) / 60_000),
      },
      models,
    );
    if (!getKalshiContract(kalshiMarket) || kalshiQuery.isError)
      return {
        ...estimate,
        available: false,
        aboveProbability: null,
        belowProbability: null,
        direction: null,
        reason:
          kalshiMarket?.target == null
            ? 'Waiting for Kalshi’s official target.'
            : 'Kalshi contract details could not be verified.',
      };
    if (!hasRequestError || hasIndependentKalshiBenchmark(estimate)) return estimate;
    return {
      ...estimate,
      available: false,
      aboveProbability: null,
      belowProbability: null,
      direction: null,
      reason: 'The market feed could not be refreshed. Retrying automatically.',
    };
  }, [
    candles,
    ticker,
    target,
    now,
    hasRequestError,
    forecastDeadline,
    stream,
    models,
    kalshiMarket,
    benchmark,
    kalshiQuery.isError,
  ]);
  const fixedProgress = useFixedPrediction({
    forecast: isJournalReady ? activeForecast : null,
    candles,
    ticker,
    now,
    hasRequestError,
    stream,
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
    now,
    progress: fixedProgress,
    isReady: isJournalReady,
    models,
    benchmark,
    kalshiOutcomes: kalshiSettlement.outcomes,
  });

  useEffect(() => {
    if (isJournalReady && now && forecasts.length)
      dispatch(forecastsObserved({ now, kalshiOutcomes: kalshiSettlement.outcomes }));
  }, [dispatch, isJournalReady, now, forecasts, kalshiSettlement.outcomes]);

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
    )
      return;
    const current = getResearchEstimate({
      target: contract.target,
      now: createdAt,
      expiresAt: contract.expiresAt,
      kalshiMarket: contract,
    });
    if (!current.available) return;
    dispatch(
      forecastRecorded({
        id: crypto.randomUUID(),
        startsAt: contract.startsAt,
        timingMode: 'end',
        createdAt,
        expiresAt: contract.expiresAt,
        price: getKalshiReferenceQuote(current, ticker).price,
        target: contract.target,
        aboveProbability: null,
        belowProbability: null,
        direction: 'neutral',
        modelVersion: KALSHI_MODEL_VERSION,
        status: 'analyzing',
        calculationMode: null,
        analysis: getFixedForecastAnalysis({
          startedAt: createdAt,
          expiresAt: contract.expiresAt,
          policyVersion: KALSHI_POLICY_VERSION,
        }),
        outcomeDefinition: KALSHI_OUTCOME_DEFINITION,
        kalshiMarket: contract,
        kalshi: null,
      }),
    );
    setIsPreparingForecast(false);
  };

  const completedCandles = candles.filter((candle) => now && candle.time + 60_000 <= now);
  const scheduleForecast = () => {
    const createdAt = Date.now();
    if (
      !isJournalReady ||
      activeForecast ||
      scheduledForecast ||
      !kalshiMarket?.rulesVerified ||
      kalshiQuery.isError ||
      kalshiMarket.startsAt <= createdAt
    )
      return;
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
  const lastCandleTime = completedCandles.at(-1)?.time;
  const historyAge = Number.isFinite(lastCandleTime) ? now - (lastCandleTime + 60_000) : null;
  const isHistoryFresh = historyAge !== null && historyAge <= 120_000 && !candleQuery.isError;
  const isFeedFresh = isQuoteFresh && !hasQuoteError && isHistoryFresh;
  const priorPrice = completedCandles.at(-16)?.close;
  const priceChange = priorPrice && ticker ? ticker.price / priorPrice - 1 : null;
  const isPositive = priceChange !== null && priceChange >= 0;

  return (
    <div className="bitcoin-tracker">
      <a className="skip-link" href="#main-content">
        Skip to tracker
      </a>
      <main id="main-content" tabIndex="-1">
        <Container fluid className="tracker-container">
          <div className="monitor-header d-flex justify-content-between align-items-center flex-wrap gap-2">
            <h1 className="mb-0">
              Bitcoin monitor <span>Kalshi · BTC 15m</span>
            </h1>
            <div className="feed-indicator d-flex align-items-center flex-wrap gap-3">
              <div className={`feed-status ${isFeedFresh ? 'fresh' : ''}`} role="status">
                <span className="status-dot" />
                {isFeedFresh
                  ? 'Live market data'
                  : isLoading
                    ? 'Connecting to market'
                    : isQuoteFresh && !quoteQuery.isError
                      ? 'Price live · history delayed'
                      : 'Market data delayed'}
              </div>
              <span className="small text-secondary">
                Coinbase · {hasStreamTicker ? 'Streaming' : 'REST fallback'}
              </span>
              <span className="local-clock small text-secondary">{formatTime(now)} local</span>
            </div>
          </div>
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
                disabled={quoteQuery.isFetching || candleQuery.isFetching}
                onClick={() => {
                  quoteQuery.refetch();
                  candleQuery.refetch();
                }}
              >
                <Icon name="refresh" size={15} /> Retry
              </Button>
            </Alert>
          )}
          {storageWarning && <Alert variant="warning">{storageWarning}</Alert>}
          {kalshiSettlement.warning && <Alert variant="warning">{kalshiSettlement.warning}</Alert>}
          <div className="tracker-workspace">
            <div className="market-panel dashboard-panel">
              <section className="price-summary" aria-labelledby="bitcoin-heading">
                <div className="d-flex align-items-center gap-2 mb-2">
                  <span className="coin-symbol" aria-hidden="true">
                    ₿
                  </span>
                  <div>
                    <h2 id="bitcoin-heading" className="section-title mb-1">
                      Bitcoin price
                    </h2>
                    <span className="text-secondary small">BTC / USD · Coinbase</span>
                  </div>
                  <span className="spot-chip ms-auto">SPOT</span>
                </div>
                <div
                  className={`d-flex align-items-baseline flex-wrap gap-3 ${!isQuoteFresh ? 'price-delayed' : ''}`}
                >
                  <span className="current-price">{formatPrice(ticker?.price)}</span>
                  {priceChange !== null && (
                    <span className={`price-change ${isPositive ? 'positive' : 'negative'}`}>
                      <Icon name={isPositive ? 'up' : 'down'} size={15} /> {isPositive ? '+' : ''}
                      {formatPercent(priceChange)}{' '}
                      <span className="text-secondary fw-normal">~15m</span>
                    </span>
                  )}
                </div>
                <p className="small text-secondary mt-2 mb-0">
                  {ticker
                    ? `Last trade ${formatTime(ticker.time)}${!isQuoteFresh ? ' · delayed, not a live price' : ''}`
                    : 'Connecting to Coinbase’s public market feed…'}
                </p>
              </section>
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
