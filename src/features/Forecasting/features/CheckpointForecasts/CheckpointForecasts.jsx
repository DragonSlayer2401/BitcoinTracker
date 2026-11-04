import ForecastPanel from './components/ForecastPanel';
import ForecastRisk from '@/features/Forecasting/features/LiveEstimates/components/ForecastRisk';

const CheckpointForecasts = ({ now, marketData, selection, journal, estimates, checkpoints }) => {
  const {
    ticker,
    stream,
    benchmark,
    kalshiMarkets,
    isQuoteFresh,
    hasQuoteError,
    isLoading,
    hasContractError,
  } = marketData;
  const {
    controls,
    activeForecast,
    recordedForecast,
    scheduledForecast,
    isPreparingForecast,
    setSelectedMarketTicker,
  } = selection;
  const {
    preferences,
    setAutoEnabled,
    setCheckpointMinutes,
    warning: preferencesWarning,
  } = controls;
  const {
    kalshiMarket,
    forecastDeadline,
    eventForecasts,
    forecast,
    riskForecast,
    savedRiskEstimate,
    savedRiskConditions,
  } = estimates;
  const { fixedProgress, recordForecast, prepareForecast, scheduleForecast } = checkpoints;
  const target = kalshiMarket?.target;
  const displayedTargetInput = Number.isFinite(target) ? target.toFixed(2) : '';
  return (
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
      preferencesWarning={preferencesWarning ?? checkpoints.warning}
      recordedForecast={recordedForecast}
      now={now}
      onRecord={recordForecast}
      onNewForecast={prepareForecast}
      scheduledForecast={scheduledForecast}
      onSchedule={scheduleForecast}
      onCancelSchedule={checkpoints.cancelSchedule}
      isJournalReady={journal.isReady}
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
        error: hasContractError,
        benchmark,
      }}
    />
  );
};
export default CheckpointForecasts;
