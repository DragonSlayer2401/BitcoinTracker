import { useDispatch, useSelector } from 'react-redux';
import JournalPanel from './components/JournalPanel';
import {
  selectForecasts,
  selectJournalSummary,
  selectJournalOutcomeGroups,
} from '@/features/Forecasting/state/selectors/forecastSelectors';
import { historyCleared } from '@/features/Forecasting/state/slices/forecastSlice';

const ForecastJournal = ({ now, isJournalReady }) => {
  const dispatch = useDispatch();
  const forecasts = useSelector(selectForecasts);
  const summary = useSelector(selectJournalSummary);
  const outcomeGroups = useSelector(selectJournalOutcomeGroups);
  const clearHistory = () => {
    if (isJournalReady) dispatch(historyCleared());
  };

  return (
    <JournalPanel
      forecasts={forecasts}
      summary={summary}
      outcomeGroups={outcomeGroups}
      now={now}
      onClear={clearHistory}
    />
  );
};

export default ForecastJournal;
