import CheckpointForecasts from './features/CheckpointForecasts/CheckpointForecasts';
import ForecastJournal from './features/ForecastJournal/ForecastJournal';

const Forecasting = ({ now, marketData, selection, journal, estimates, checkpoints, children }) => (
  <>
    <CheckpointForecasts
      now={now}
      marketData={marketData}
      selection={selection}
      journal={journal}
      estimates={estimates}
      checkpoints={checkpoints}
    />
    {children}
    <ForecastJournal now={now} isJournalReady={journal.isReady} />
  </>
);

export default Forecasting;
