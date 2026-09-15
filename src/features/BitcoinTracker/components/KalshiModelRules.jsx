export default function KalshiModelRules() {
  return (
    <div className="row g-4">
      <section className="col-md-6">
        <h3 className="h6">What the prediction means</h3>
        <p>
          The selected Kalshi Bitcoin event supplies the target and close time. Yes wins when its
          final-minute CF Benchmarks BRTI average, rounded to cents, is at or above the target. No
          wins below it. A tie is Yes. The official Kalshi result determines the score.
        </p>
        <p>
          The countdown ends at the market close, even when settlement is published later. A
          Coinbase last trade does not settle a Kalshi forecast.
        </p>
      </section>
      <section className="col-md-6">
        <h3 className="h6">Probability model</h3>
        <p>
          With enough complete BRTI history, the model measures volatility and price movement from
          the same index Kalshi uses. Recent moves receive more weight, and a sudden jump widens
          uncertainty. Coinbase candles provide a fallback while index history is incomplete.
          Executed Coinbase buying and selling pressure shifts the projected prices. Larger spot
          trades contribute by their BTC volume. Weak or missing pressure does not prevent a valid
          estimate.
        </p>
        <p>
          The model estimates the average of the 60 benchmark readings. Prices seconds apart are
          related, so it does not count them as 60 independent predictions. This is an unvalidated
          approximation of future market behavior.
        </p>
      </section>
      <section className="col-md-6">
        <h3 className="h6">Futures and liquidations</h3>
        <p>
          Bybit BTCUSDT futures executions contribute to the current probability calculation before
          any learning model. Recent buying and selling, unusually large trades, and the observed
          price response produce a small, decaying adjustment. Selling that prices absorb receives
          less directional weight. The initial price-response fit needs six completed 15-second
          intervals.
        </p>
        <p>
          Reported long and short liquidations add directional context and temporary uncertainty.
          Their volume is not counted again as additional executions. Effects apply only to future
          settlement readings and stay bounded by BRTI volatility. A missing or warming futures feed
          leaves the existing calculation available. These assumptions have not established
          predictive accuracy.
        </p>
      </section>
      <section className="col-md-6">
        <h3 className="h6">The final minute</h3>
        <p>
          Received benchmark readings become a known part of the ending average. The remaining
          readings are estimated. Missing readings from elapsed seconds stay uncertain, including
          when the app joins late. A price crossing alone does not mean the settlement average
          crossed.
        </p>
        <p>
          The chart shows CF Benchmarks BRTI readings. The interval at the closing time estimates
          the settlement average, rather than a future spot-price path.
        </p>
      </section>
      <section className="col-md-6">
        <h3 className="h6">Fixed prediction and reversal risk</h3>
        <p>
          Choose any of 12, 9, 6, 3 and 1 minute remaining. Each checkpoint saves a separate fixed
          call from the current model, including a weak lean. Its target, deadline and percentages
          stay unchanged. A five-second capture window allows for scheduling delays; a missed
          checkpoint is never filled in with a later prediction. Older saved calls retain their
          original observation policy.
        </p>
        <p>
          Auto record repeats the selected checkpoints for each newly open event while the browser
          is running. Changes apply to the next event. Turning Auto off stops future event starts;
          the current event still finishes. One tab owns recording to avoid duplicate calls.
        </p>
        <p>
          Live risk estimates the chance the fixed Yes/No call will lose. It uses that saved
          contract. With several checkpoints, the risk button identifies the latest published call.
          It is an estimated chance, not a measured success rate.
        </p>
      </section>
      <section className="col-md-6">
        <h3 className="h6">Benchmark access</h3>
        <p>
          Without authorized BRTI access, the model uses an explicitly labeled Coinbase proxy. A
          shared venue-to-index uncertainty floor of 0.05% remains in the calculation; this is an
          engineering assumption, not a fitted error rate.
        </p>
        <p>
          To connect BRTI, configure KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY on the server. Kalshi
          must enable the required entitlement. Credentials stay on the server. Access and any
          data-distribution terms need confirmation with Kalshi; no paid subscription is purchased
          by this tool.
        </p>
      </section>
      <section className="col-md-6">
        <h3 className="h6">Learning and validation</h3>
        <p>
          Automatic research follows actual Kalshi events and captures estimates with 12, 9, 6, 3
          and 1 minute remaining. Each event is one independent outcome, even with several
          snapshots. Missing checkpoints are recorded as missing.
        </p>
        <p>
          Early learning fits a small correction after at least 40 events, then tests it on a fixed
          group of 40 future events. A candidate changes no displayed probabilities. If approved, it
          blends in 20% of the correction and changes a probability by at most 5 percentage points
          in either direction. Later outcome checks can suspend the adjustment.
        </p>
        <p>
          The full model keeps separate training, calibration and test groups of at least 120, 60
          and 60 events, followed by 120 future validation events. Only real Kalshi outcomes train
          either model. BRTI and Coinbase history are evaluated separately, and older model inputs
          cannot qualify a new version. New training never rewrites a saved call.
        </p>
        <p>
          Keep the app or the persistent research collector running to capture inputs. Official
          settlement can be retrieved after reconnection. Scores show observed performance, not
          guaranteed future accuracy.
        </p>
      </section>
      <div className="col-12 small">
        Sources:{' '}
        <a
          href="https://help.kalshi.com/en/articles/13823838-crypto-markets"
          target="_blank"
          rel="noreferrer"
        >
          Kalshi settlement
        </a>
        {' · '}
        <a
          href="https://docs.kalshi.com/cfbenchmarks/rest-passthrough"
          target="_blank"
          rel="noreferrer"
        >
          Benchmark API access
        </a>
        {' · '}
        <a
          href="https://docs.kalshi.com/api-reference/market/get-market"
          target="_blank"
          rel="noreferrer"
        >
          Market rules and official results
        </a>
      </div>
    </div>
  );
}
