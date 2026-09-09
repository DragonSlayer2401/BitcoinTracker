import { useState } from 'react';
import { Button, Modal } from 'react-bootstrap';
import Icon from './Icon';
import ResearchData from './ResearchData';

export default function Methodology({ evidenceWarning }) {
  const [showRules, setShowRules] = useState(false);

  return (
    <section id="methodology" className="methodology-section" aria-label="Model and data rules">
      <div className="d-flex align-items-center gap-2 mb-2">
        <Icon name="info" />
        <h2 className="section-title mb-0">Model and data rules</h2>
      </div>
      <p className="small text-secondary mb-2">
        Records a fixed estimate after three minutes with fresh data. Trade pressure adjusts the
        math; accuracy remains unvalidated. Keep this tab open for observation and outcomes.
      </p>
      <div className="d-flex flex-wrap gap-2 mt-auto">
        <Button size="sm" variant="outline-secondary" onClick={() => setShowRules(true)}>
          View model rules
        </Button>
        <ResearchData warning={evidenceWarning} />
      </div>
      {evidenceWarning && (
        <span className="small text-warning mt-1" role="status">
          Research recording paused · see Research data
        </span>
      )}
      <Modal
        show={showRules}
        onHide={() => setShowRules(false)}
        className="tracker-modal"
        centered
        scrollable
        size="lg"
        aria-labelledby="model-dialog-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="model-dialog-heading" as="h2" className="h5">
            Model and data rules
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <div className="row g-4">
            <div className="col-md-6">
              <h3 className="h6">Probability model</h3>
              <p>
                The model starts with distance from the target, recent price movement, and time
                remaining. Executed buying and selling pressure shifts the estimated ending-price
                distribution. Its strength is estimated from completed 15-second trade samples,
                reduced when evidence is weak, capped, and allowed to fade with time. Recent candle
                ranges, volatility, price jumps, and the spread contribute to uncertainty.
              </p>
              <p className="mb-0">
                Probabilities are bounded to 1–99%. A leading side below 55% is labeled a slight
                lean; exactly 50/50 has no directional edge. Missing or unusable trade-flow history
                falls back to the price-only estimate and is labeled. Once captured, the fixed
                prediction keeps its original probabilities through the countdown, result, and
                reload. A separate live estimate uses the editable preview target and the saved
                deadline. Editing the target never changes the recorded prediction. The live
                estimate, chart's live 80% model range, and live window volatility stop at the
                deadline. Predictive accuracy and interval coverage have not been independently
                validated.
              </p>
            </div>
            <div className="col-md-6">
              <h3 className="h6">Fixed prediction observation</h3>
              <p>
                New windows observe for three minutes, then record the first available estimate.
                There is no 65% minimum and no full minute of matching directional signals. A weak
                estimate is still recorded with its actual probabilities. Live estimates remain
                visible during observation.
              </p>
              <p className="mb-0">
                The decision window closes after 5 minutes or one minute before the original end,
                whichever comes first. A late join never extends the end. Insufficient time, or
                unavailable essential price/history data produces “No clear signal,” with no fixed
                probabilities or scored call. Editing the live target does not change the target
                being observed. Older immediate forecasts keep their original captured predictions.
              </p>
              <p className="mt-2 mb-0">
                Pressure is based on traded BTC volume, so larger executions contribute more.
                Large-trade labels do not add a second bonus. The adjustment uses an observed
                short-term relationship, not a proven ability to predict future returns. Older saved
                windows retain their original publication policy and percentages.
              </p>
            </div>
            <div className="col-md-6">
              <h3 className="h6">Data requirements</h3>
              <p>
                Coinbase BTC/USD trades, quotes and Level 2 depth stream live; candle history
                refreshes every 60 seconds. Fresh REST quotes can support a labeled price-only
                estimate while the stream recovers. Estimates pause when a quote is over 20 seconds
                old, history is stale or has gaps, or volatility fails the model’s checks. At least
                60 consecutive returns are required.
              </p>
              <p className="mb-0">
                News and exchange differences remain outside the model. The added market inputs do
                not guarantee an accurate prediction. Prices and results refer only to Coinbase
                BTC/USD.
              </p>
            </div>
            <div className="col-md-6">
              <h3 className="h6">Start and observation windows</h3>
              <p>
                Choose Start now, End time, or Start time. An end time sets the window start 15
                minutes earlier. The deadline is exactly 15 minutes after that start. If the end is
                12 minutes away, submitting joins that window now with fresh data and a 12:00
                countdown. Observation starts when you join, and estimates cover only the remaining
                time; nothing is backfilled to the earlier start. End times must be in the future.
              </p>
              <p className="mb-0">
                Future starts can be up to 24 hours ahead. Before the start, 15:00 stays visible
                with a separate Starts in countdown; original probabilities wait for capture while
                the live preview covers 15 minutes from now. A scheduled or recorded target stays
                saved while target edits update only the preview. Choose New forecast after
                completion or a no-call decision to start another window with your edited target.
                Starting scheduled observation has up to 15 seconds of grace and never moves the
                deadline; a missed start is not automatically recovered. New outcomes use the last
                verified executed Coinbase trade at or before the deadline, no older than five
                seconds, after a heartbeat confirms complete trade delivery through that deadline. A
                gap or missing confirmation leaves it unobserved. Earlier records retain their
                original first-sample-within-15-seconds-after rule. Keep this tab open for scheduled
                starts, continuous observation, and sampled outcomes.
              </p>
            </div>
            <div className="col-md-6">
              <h3 className="h6">Journal metrics</h3>
              <p>
                Current pressure forecasts are scored separately from earlier policies. Directional
                accuracy excludes neutral calls, ties, and no-call windows. Brier score measures
                mean squared probability error; lower is better and constant 50% forecasts score
                0.25. Ties and no-call windows are excluded. Call coverage reports how often
                completed observation decisions issued a prediction, alongside accuracy so selective
                calls cannot hide withheld windows. Ongoing observation and older immediate
                forecasts are excluded from coverage. The editable, browser-local sample does not
                establish a predictive edge or calibrated probabilities.
              </p>
              <p className="mb-0">
                History retains up to 100 forecasts and does not sync between tabs or devices.
              </p>
            </div>
            <div className="col-12">
              <p className="mb-0">
                Data:{' '}
                <a
                  href="https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-ticker"
                  target="_blank"
                  rel="noreferrer"
                >
                  Coinbase Exchange ticker
                </a>{' '}
                and{' '}
                <a
                  href="https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles"
                  target="_blank"
                  rel="noreferrer"
                >
                  one-minute candles
                </a>
                .
              </p>
            </div>
          </div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setShowRules(false)}>
            Close rules
          </Button>
        </Modal.Footer>
      </Modal>
    </section>
  );
}
