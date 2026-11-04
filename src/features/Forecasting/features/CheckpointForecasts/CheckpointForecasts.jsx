import ForecastPanel from './components/ForecastPanel';

const CheckpointForecasts = ({
  now,
  marketData,
  selection,
  journal,
  estimates,
  checkpoints,
  children,
}) => {
  const { kalshiMarkets, hasContractError } = marketData;
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
  const { kalshiMarket, forecastDeadline, eventForecasts, forecast } = estimates;
  const { fixedProgress, recordForecast, prepareForecast, scheduleForecast } = checkpoints;
  const target = kalshiMarket?.target;
  const displayedTargetInput = Number.isFinite(target) ? target.toFixed(2) : '';
  return (
    <ForecastPanel
      targetInput={displayedTargetInput}
      isForecastAvailable={forecast.available}
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
      kalshi={{
        market: kalshiMarket,
        markets: kalshiMarkets,
        onSelect: setSelectedMarketTicker,
        error: hasContractError,
      }}
    >
      {children}
    </ForecastPanel>
  );
};
export default CheckpointForecasts;
