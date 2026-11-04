import useBackgroundResearch from '../features/EvidenceCollection/hooks/useBackgroundResearch';
import useResearchSync from '../features/EvidenceCollection/hooks/useResearchSync';
import useResearchLearning from '../features/ModelLearning/hooks/useResearchLearning';
import useResearchEstimates from './useResearchEstimates';

const useForecastResearch = ({ forecasts, journal, now, marketData }) => {
  const { ticker, stream, benchmark, kalshiMarkets } = marketData;
  const researchSync = useResearchSync({ forecasts, isReady: journal.isReady, now });
  const { models, warning: learningWarning } = useResearchLearning({
    isReady: journal.isRestored,
    canReview: journal.isReady,
    now,
  });
  const { getResearchEstimate, getResearchConditions } = useResearchEstimates({
    marketData,
    models,
  });
  const backgroundResearch = useBackgroundResearch({
    now,
    isReady: journal.isReady,
    ticker,
    stream,
    getEstimate: getResearchEstimate,
    getConditions: getResearchConditions,
    markets: kalshiMarkets,
    benchmark,
  });

  return {
    models,
    getResearchEstimate,
    getResearchConditions,
    researchStatus: { ...researchSync, background: backgroundResearch.status },
    researchWarning: researchSync.warning ?? backgroundResearch.warning ?? learningWarning,
  };
};

export default useForecastResearch;
