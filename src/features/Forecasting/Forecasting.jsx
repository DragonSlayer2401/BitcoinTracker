import CheckpointForecasts from './features/CheckpointForecasts/CheckpointForecasts';
import ForecastJournal from './features/ForecastJournal/ForecastJournal';
import LiveEstimates from './features/LiveEstimates/LiveEstimates';

const Forecasting = ({ now, marketData, selection, journal, estimates, checkpoints, children }) => (
  <>
    <CheckpointForecasts
      now={now}
      marketData={marketData}
      selection={selection}
      journal={journal}
      estimates={estimates}
      checkpoints={checkpoints}
    >
      <LiveEstimates
        now={now}
        marketData={marketData}
        recordedForecast={selection.recordedForecast}
        estimates={estimates}
      />
    </CheckpointForecasts>
    {children}
    <ForecastJournal now={now} isJournalReady={journal.isReady} />
  </>
);

export default Forecasting;
