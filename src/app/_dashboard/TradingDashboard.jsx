'use client';

import { useSelector } from 'react-redux';
import { Alert, Button, Container } from 'react-bootstrap';
import Icon from '@/components/Icon';
import useClock from '@/hooks/useClock';
import useMarketData from '@/features/MarketData/hooks/useMarketData';
import useForecastResearch from '@/features/ForecastResearch/hooks/useForecastResearch';
import MarketData from '@/features/MarketData/MarketData';
import MarketFeeds from '@/features/MarketData/features/MarketFeeds/MarketFeeds';
import SimulatedTrading from '@/features/SimulatedTrading/SimulatedTrading';
import useForecastEvidence from '@/features/ForecastResearch/features/EvidenceCollection/hooks/useForecastEvidence';
import useForecastJournal from '@/features/Forecasting/features/ForecastJournal/hooks/useForecastJournal';
import { hasIndependentKalshiBenchmark } from '@/features/Forecasting/features/LiveEstimates/utils/kalshi/marketConditions.utils';
import Forecasting from '@/features/Forecasting/Forecasting';
import useForecastSelection from '@/features/Forecasting/features/CheckpointForecasts/hooks/useForecastSelection';
import useEventEstimates from '@/features/Forecasting/features/LiveEstimates/hooks/useEventEstimates';
import useCheckpointForecasts from '@/features/Forecasting/features/CheckpointForecasts/hooks/useCheckpointForecasts';
import useForecastOutcomes from '@/features/Forecasting/features/ForecastJournal/hooks/useForecastOutcomes';
import { selectStorageWarning } from '@/features/Forecasting/state/selectors/forecastSelectors';
import TrackerHeader from './TrackerHeader';
import Methodology from './Methodology';
import './TradingDashboard.scss';

const TradingDashboard = () => {
  const now = useClock();
  const journal = useForecastJournal();
  const selection = useForecastSelection();
  const { forecasts } = selection;
  const marketData = useMarketData({ now, preferredTicker: selection.preferredTicker });
  const research = useForecastResearch({ forecasts, journal, now, marketData });
  const estimates = useEventEstimates({ now, marketData, selection, research });
  const checkpoints = useCheckpointForecasts({
    now,
    selection,
    marketData,
    kalshiMarket: estimates.kalshiMarket,
    isJournalReady: journal.isReady,
    research,
  });
  const settlement = useForecastOutcomes({ forecasts, now, isReady: journal.isReady });
  const storageWarning = useSelector(selectStorageWarning);
  const {
    stream,
    ticker,
    candles,
    quoteAge,
    historyAge,
    hasStreamTicker,
    isQuoteFresh,
    hasRequestError,
    isRefreshing,
    refreshMarketData,
    derivatives,
    benchmark,
    benchmarkData,
    currentMarket,
    hasContractError,
  } = marketData;
  const evidenceWarning = useForecastEvidence({
    forecasts,
    candles,
    ticker,
    stream,
    derivatives,
    now,
    progress: checkpoints.fixedProgress,
    isReady: journal.isReady,
    models: research.models,
    benchmark,
    kalshiOutcomes: settlement.outcomes,
  });

  return (
    <div className="bitcoin-tracker advisor-dashboard">
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
                {hasIndependentKalshiBenchmark(estimates.forecast)
                  ? 'Coinbase data is reconnecting. BRTI-based estimates remain available.'
                  : 'Market data is temporarily unavailable. Estimates are paused while we reconnect.'}
                {selection.recordedForecast &&
                  (['analyzing', 'withheld'].includes(selection.recordedForecast.status)
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
          {settlement.warning && <Alert variant="warning">{settlement.warning}</Alert>}
          <SimulatedTrading
            market={currentMarket}
            now={now}
            hasMarketError={hasContractError}
            chart={<MarketData marketData={marketData} now={now} />}
            renderResearch={(paperTrading) => (
              <>
                <Forecasting
                  now={now}
                  marketData={marketData}
                  journal={journal}
                  selection={selection}
                  checkpoints={checkpoints}
                  estimates={estimates}
                >
                  <MarketFeeds
                    ticker={ticker}
                    quoteAge={quoteAge}
                    isQuoteFresh={isQuoteFresh}
                    historyAge={historyAge}
                    forecast={estimates.forecast}
                    stream={stream}
                    derivatives={derivatives}
                    conditions={estimates.marketConditions}
                  />
                </Forecasting>
                <Methodology
                  evidenceWarning={evidenceWarning ?? research.researchWarning}
                  researchStatus={research.researchStatus}
                  paperTrading={paperTrading}
                />
              </>
            )}
          />
        </Container>
      </main>
    </div>
  );
};

export default TradingDashboard;
