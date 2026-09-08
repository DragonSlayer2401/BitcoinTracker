'use client';

import { useEffect, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Alert, Button, Container } from 'react-bootstrap';
import { useGetCandlesQuery, useGetTickerQuery } from '@/services/coinbase/coinbase.api';
import Icon from './components/Icon';
import PriceChart from './components/PriceChart';
import MarketData from './components/MarketData';
import ForecastPanel from './components/ForecastPanel';
import ForecastJournal from './components/ForecastJournal';
import Methodology from './components/Methodology';
import useClock from './hooks/useClock';
import useForecastJournal from './hooks/useForecastJournal';
import useScheduledForecast from './hooks/useScheduledForecast';
import { getForecast } from './utils/forecast.utils';
import { formatPercent, formatPrice, formatTime } from './utils/format.utils';
import {
  forecastRecorded,
  forecastsObserved,
  historyCleared,
  scheduleCreated,
  scheduleCancelled,
} from './state/slices/trackerSlice';
import { getEndScheduleError, getScheduleError, parseScheduledStart } from './utils/schedule.utils';
import {
  selectActiveForecast,
  selectForecasts,
  selectJournalSummary,
  selectTrackerState,
  selectScheduledForecast,
} from './state/selectors/trackerSelectors';
import './BitcoinTracker.scss';

const EMPTY_CANDLES = [];

export default function BitcoinTracker() {
  const now = useClock();
  const dispatch = useDispatch();
  const isJournalReady = useForecastJournal();
  const [targetInput, setTargetInput] = useState('');
  const [hasEditedTarget, setHasEditedTarget] = useState(false);
  const [isPreparingForecast, setIsPreparingForecast] = useState(false);
  const [timingSelection, setTimingSelection] = useState({
    mode: 'now',
    value: '',
    timestamp: null,
  });
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
  const ticker = quoteQuery.data;
  const candles = candleQuery.data || EMPTY_CANDLES;
  const forecasts = useSelector(selectForecasts);
  const activeForecast = useSelector(selectActiveForecast);
  const scheduledForecast = useSelector(selectScheduledForecast);
  const recordedForecast =
    activeForecast ?? (!isPreparingForecast && !scheduledForecast ? (forecasts[0] ?? null) : null);
  const savedTarget =
    recordedForecast?.target ??
    (scheduledForecast?.status === 'scheduled' ? scheduledForecast.target : undefined);
  const forecastDeadline =
    recordedForecast?.expiresAt ??
    (scheduledForecast?.status === 'scheduled'
      ? scheduledForecast.expiresAt
      : timingSelection.mode === 'scheduled-end'
        ? (timingSelection.timestamp ?? parseScheduledStart(timingSelection.value))
        : null);
  const horizonMinutes =
    forecastDeadline === null ? 15 : Math.min(15, (forecastDeadline - now) / 60_000);
  const summary = useSelector(selectJournalSummary);
  const { storageWarning } = useSelector(selectTrackerState);
  const target = targetInput.trim() === '' ? NaN : Number(targetInput);
  const quoteAge = ticker && now ? now - ticker.time : null;
  const isQuoteFresh =
    quoteAge !== null &&
    quoteAge <= 20_000 &&
    quoteAge >= -5000 &&
    now - ticker.receivedAt <= 20_000 &&
    now - ticker.receivedAt >= -5000;
  const hasRequestError = quoteQuery.isError || candleQuery.isError;
  const isLoading = quoteQuery.isLoading || candleQuery.isLoading;
  useScheduledForecast({
    ticker,
    candles,
    now,
    isReady: isJournalReady,
    hasRequestError,
    refetchTicker: quoteQuery.refetch,
    refetchCandles: candleQuery.refetch,
  });
  const forecast = useMemo(() => {
    const estimate = getForecast({ candles, ticker, target, now, horizonMinutes });
    if (!hasRequestError) return estimate;
    return {
      ...estimate,
      available: false,
      aboveProbability: null,
      belowProbability: null,
      direction: null,
      reason: 'The market feed could not be refreshed. Retrying automatically.',
    };
  }, [candles, ticker, target, now, hasRequestError, horizonMinutes]);

  useEffect(() => {
    if (isJournalReady && !hasEditedTarget && (savedTarget !== undefined || ticker)) {
      setTargetInput((savedTarget ?? ticker.price).toFixed(2));
      setHasEditedTarget(true);
    }
  }, [ticker, hasEditedTarget, isJournalReady, savedTarget]);

  useEffect(() => {
    if (isJournalReady && now && activeForecast)
      dispatch(forecastsObserved({ ticker: quoteQuery.isError ? null : ticker, now }));
  }, [activeForecast, dispatch, isJournalReady, now, ticker, quoteQuery.isError]);

  const changeTarget = (value) => {
    setHasEditedTarget(true);
    setTargetInput(value);
  };
  const prepareForecast = () => {
    setIsPreparingForecast(true);
    setHasEditedTarget(true);
    setTimingSelection({ mode: 'now', value: '', timestamp: null });
  };
  const recordForecast = ({ startMode, startsAt: requestedStart, expiresAt: requestedEnd }) => {
    // Recheck at the click time so a quote cannot age past the guard between renders.
    const createdAt = Date.now();
    if (activeForecast || scheduledForecast?.status === 'scheduled' || !isJournalReady) return;
    const isEndTime = startMode === 'scheduled-end';
    const startsAt = isEndTime ? requestedEnd - 900_000 : requestedStart;
    const expiresAt = isEndTime
      ? requestedEnd
      : startMode === 'scheduled'
        ? startsAt + 900_000
        : createdAt + 900_000;
    if (isEndTime && getEndScheduleError(expiresAt, createdAt)) return;
    if (startMode === 'scheduled' || (isEndTime && startsAt > createdAt)) {
      if (
        getScheduleError(startsAt, createdAt) ||
        !Number.isFinite(target) ||
        target <= 0 ||
        target > 1e9
      )
        return;
      dispatch(
        scheduleCreated({
          id: crypto.randomUUID(),
          createdAt,
          startsAt,
          expiresAt,
          target,
          status: 'scheduled',
        }),
      );
      setIsPreparingForecast(false);
      return;
    }
    const current = getForecast({
      candles,
      ticker,
      target,
      now: createdAt,
      horizonMinutes: (expiresAt - createdAt) / 60_000,
    });
    if (!current.available || hasRequestError) return;
    dispatch(
      forecastRecorded({
        id: crypto.randomUUID(),
        ...(isEndTime ? { startsAt, timingMode: 'end' } : {}),
        createdAt,
        expiresAt,
        price: ticker.price,
        target,
        aboveProbability: current.aboveProbability,
        belowProbability: current.belowProbability,
        direction: current.direction,
        modelVersion: current.modelVersion,
        status: 'pending',
      }),
    );
    setIsPreparingForecast(false);
  };

  const completedCandles = candles.filter((candle) => now && candle.time + 60_000 <= now);
  const lastCandleTime = completedCandles.at(-1)?.time;
  const historyAge = Number.isFinite(lastCandleTime) ? now - (lastCandleTime + 60_000) : null;
  const isHistoryFresh = historyAge !== null && historyAge <= 120_000 && !candleQuery.isError;
  const isFeedFresh = isQuoteFresh && !quoteQuery.isError && isHistoryFresh;
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
              Bitcoin monitor <span>BTC / USD</span>
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
              <span className="small text-secondary">Coinbase · 5s refresh</span>
              <span className="local-clock small text-secondary">{formatTime(now)} local</span>
            </div>
          </div>
          {hasRequestError && (
            <Alert
              variant="warning"
              className="d-flex align-items-center justify-content-between gap-3"
            >
              <span>
                Market data is temporarily unavailable. Estimates are paused while we reconnect.
                {recordedForecast && ' The fixed prediction is retained.'}
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
              targetInput={targetInput}
              onTargetChange={changeTarget}
              ticker={isQuoteFresh && !quoteQuery.isError ? ticker : null}
              forecast={forecast}
              forecastDeadline={forecastDeadline}
              timingSelection={timingSelection}
              onTimingChange={setTimingSelection}
              activeForecast={activeForecast}
              recordedForecast={recordedForecast}
              scheduledForecast={scheduledForecast}
              now={now}
              onRecord={recordForecast}
              onNewForecast={prepareForecast}
              isJournalReady={isJournalReady}
              onCancelSchedule={() => dispatch(scheduleCancelled())}
              isLoading={isLoading}
            />
            <MarketData
              ticker={ticker}
              quoteAge={quoteAge}
              isQuoteFresh={isQuoteFresh}
              historyAge={historyAge}
              forecast={forecast}
            />
            <ForecastJournal
              forecasts={forecasts}
              summary={summary}
              now={now}
              onClear={() => dispatch(historyCleared())}
            />
            <Methodology />
          </div>
        </Container>
      </main>
    </div>
  );
}
