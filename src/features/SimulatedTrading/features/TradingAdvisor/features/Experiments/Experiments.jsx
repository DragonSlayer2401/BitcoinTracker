import AdvisorHistoryTrials from './components/AdvisorHistoryTrials';
import AdvisorStrategyTrials from './components/AdvisorStrategyTrials';

const Experiments = ({ strategyTrials, historyTrials, isBaselineAccount }) => (
  <>
    {(isBaselineAccount || strategyTrials) && <AdvisorStrategyTrials trials={strategyTrials} />}
    <AdvisorHistoryTrials trials={historyTrials} />
  </>
);

export default Experiments;
