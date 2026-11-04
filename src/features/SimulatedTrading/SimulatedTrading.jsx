import PaperTrading from './features/PaperTrading/PaperTrading';
import TradingAdvisor from './features/TradingAdvisor/TradingAdvisor';

const SimulatedTrading = ({ market, now, hasMarketError, chart, renderResearch }) => (
  <TradingAdvisor
    market={market}
    now={now}
    hasMarketError={hasMarketError}
    chart={chart}
    research={renderResearch(<PaperTrading />)}
  />
);

export default SimulatedTrading;
