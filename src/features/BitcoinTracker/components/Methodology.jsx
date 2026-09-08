import { useState } from 'react';
import { Button, Modal } from 'react-bootstrap';
import Icon from './Icon';

export default function Methodology() {
  const [showRules, setShowRules] = useState(false);

  return (
    <section id="methodology" className="methodology-section" aria-label="Model and data rules">
      <div className="d-flex align-items-center gap-2 mb-2">
        <Icon name="info" />
        <h2 className="section-title mb-0">Model and data rules</h2>
      </div>
      <p className="small text-secondary mb-2">
        Observes for 3–5 minutes before a fixed call. Signals and probabilities are unvalidated.
        Keep this tab open for observation and outcomes.
      </p>
      <Button size="sm" variant="outline-secondary" onClick={() => setShowRules(true)}>
        View model rules
      </Button>
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
                One-minute log-return volatility uses up to 120 completed candles and scales to the
                time remaining at capture. The baseline assumes normally distributed log returns and
                zero drift. It does not extrapolate recent momentum.
              </p>
              <p className="mb-0">
                Probabilities are bounded to 1–99%. Below 55% for either direction, the result is
                “Too close to call” in the live estimate. The baseline stays in use until historical
                evaluation supports a better model. Once captured, the fixed prediction keeps its
                original probabilities through the countdown, result, and reload. A separate live
                estimate uses the editable preview target and the saved deadline. Editing the target
                never changes the recorded prediction. The live estimate, chart's live 80% model
                range, and live window volatility stop at the deadline. Predictive accuracy and
                interval coverage have not been independently validated.
              </p>
            </div>
            <div className="col-md-6">
              <h3 className="h6">Fixed prediction observation</h3>
              <p>
                New windows first observe fresh market data for at least 3 minutes. A fixed call
                requires the same direction to stay at or above 65% model probability for 60
                seconds, with at least 7 distinct qualifying quotes. This publication threshold is
                not a measured 65% accuracy rate. Live estimates remain visible during observation.
              </p>
              <p className="mb-0">
                The decision window closes after 5 minutes or one minute before the original end,
                whichever comes first. A late join never extends the end. Insufficient time,
                interrupted market data, or a signal that does not meet the rule produces “No clear
                signal,” with no fixed probabilities or scored call. Editing the live target does
                not change the target being observed. Older immediate forecasts keep their original
                captured predictions.
              </p>
            </div>
            <div className="col-md-6">
              <h3 className="h6">Data requirements</h3>
              <p>
                Coinbase BTC/USD quotes refresh every 5 seconds and candle history every 60 seconds.
                Estimates pause when a quote is over 20 seconds old, history is stale or has gaps,
                or volatility fails the model’s checks. At least 60 consecutive returns are
                required.
              </p>
              <p className="mb-0">
                News, price jumps, changing volatility, and exchange differences are outside the
                model. Prices and results refer only to Coinbase BTC/USD.
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
                deadline; a missed start is not automatically recovered. Outcomes use the first
                fresh quote this tab observes with an exchange time within 15 seconds after the
                deadline. A missed outcome stays unobserved. Keep this tab open for scheduled
                starts, continuous observation, and sampled outcomes.
              </p>
            </div>
            <div className="col-md-6">
              <h3 className="h6">Journal metrics</h3>
              <p>
                Directional accuracy excludes neutral calls, ties, and no-call windows. Brier score
                measures mean squared probability error; lower is better and constant 50% forecasts
                score 0.25. Ties and no-call windows are excluded. Call coverage reports how often
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
