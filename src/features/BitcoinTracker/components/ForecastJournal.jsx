import { useRef, useState } from 'react';
import { Button, Modal, Table } from 'react-bootstrap';
import Icon from './Icon';
import {
  formatCountdown,
  formatPercent,
  formatPrice,
  formatTime,
  getPredictionLabel,
} from '../utils/format.utils';

function ForecastTable({ forecasts, now, compact = false }) {
  return (
    <Table
      responsive={!compact}
      className={`journal-table align-middle mb-0 ${compact ? 'journal-preview-table' : ''}`}
    >
      <caption className="visually-hidden">
        {compact
          ? 'Latest recorded Bitcoin forecast'
          : 'Recorded Bitcoin forecasts and observed outcomes'}
      </caption>
      <thead>
        <tr>
          <th scope="col">Target / window</th>
          <th scope="col">Estimate</th>
          {!compact && <th scope="col">Yes / No</th>}
          {!compact && <th scope="col">Settlement average</th>}
          <th scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        {forecasts.map((entry) => (
          <tr key={entry.id}>
            <th scope="row">
              <strong>{formatPrice(entry.target)}</strong>
              <span className="d-block small text-secondary fw-normal">
                {new Date(entry.expiresAt).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}{' '}
                · {formatTime(entry.startsAt ?? entry.createdAt)}–{formatTime(entry.expiresAt)}
              </span>
              {!compact && (
                <span className="d-block small text-secondary fw-normal">
                  {`Kalshi · ${entry.kalshiMarket?.ticker ?? 'Bitcoin 15m'}`}
                </span>
              )}
            </th>
            <td>
              <span className={`direction-label ${entry.direction}`}>
                {entry.status === 'analyzing'
                  ? 'Observing'
                  : entry.status === 'withheld'
                    ? 'No clear signal'
                    : getPredictionLabel(entry)}
              </span>
            </td>
            {!compact && (
              <>
                <td className="tabular">
                  {['analyzing', 'withheld'].includes(entry.status)
                    ? 'Not issued'
                    : `${formatPercent(entry.aboveProbability)} / ${formatPercent(entry.belowProbability)}`}
                </td>
                <td className="tabular">
                  {formatPrice(entry.observedPrice)}
                  {entry.observedAt && (
                    <span className="d-block text-secondary small">Official Kalshi settlement</span>
                  )}
                </td>
              </>
            )}
            <td>
              {entry.status === 'analyzing' ? (
                <span className="result-chip">Observing</span>
              ) : entry.status === 'withheld' ? (
                <span className="result-chip">No call · unscored</span>
              ) : entry.status === 'pending' ? (
                <span className="result-chip">
                  <Icon name="clock" size={13} />{' '}
                  {formatCountdown(entry.expiresAt - Math.max(now, entry.createdAt))}
                </span>
              ) : entry.status === 'awaiting-settlement' ? (
                <span className="result-chip">Awaiting Kalshi</span>
              ) : entry.status === 'unobserved' ? (
                <span className="text-secondary">Unobserved</span>
              ) : (
                <span
                  className={`result-chip ${entry.correct === true ? 'correct' : entry.correct === false ? 'incorrect' : ''}`}
                >
                  {entry.outcome === 'equal'
                    ? 'At target · unscored'
                    : entry.correct === null
                      ? 'Neutral · unscored'
                      : entry.correct
                        ? 'Correct'
                        : 'Incorrect'}
                </span>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

function JournalSummary({ summary, compact = false, current = false }) {
  return (
    <div className="journal-summary d-flex gap-3 flex-wrap small text-secondary">
      <span>
        Scored: <strong className="text-body">{summary.scoredCount}</strong>
      </span>
      <span>
        {current ? 'Current policy accuracy' : 'Observed accuracy'}:{' '}
        <strong className="text-body">{formatPercent(summary.accuracy)}</strong>
      </span>
      {!compact && (
        <span>
          Brier:{' '}
          <strong className="text-body">
            {Number.isFinite(summary.brierScore) ? summary.brierScore.toFixed(3) : '—'}
          </strong>
        </span>
      )}
      <span>
        No calls: <strong className="text-body">{summary.withheldCount ?? 0}</strong>
      </span>
      <span>
        Call coverage: <strong className="text-body">{formatPercent(summary.coverage)}</strong>
      </span>
      {!compact && (
        <>
          <span>
            Observing: <strong className="text-body">{summary.analysisCount ?? 0}</strong>
          </span>
          <span>
            Issued after observation:{' '}
            <strong className="text-body">{summary.callCount ?? 0}</strong>
          </span>
        </>
      )}
    </div>
  );
}

function EmptyJournal() {
  return (
    <div className="journal-empty">
      <h3 className="h6 mb-1">No recorded forecasts</h3>
      <p className="small text-secondary mb-0">
        Forecasts appear here when their countdown starts.
      </p>
    </div>
  );
}

export default function ForecastJournal({ forecasts, summary, outcomeGroups, now, onClear }) {
  const [showHistory, setShowHistory] = useState(false);
  const [showClear, setShowClear] = useState(false);
  const historyButton = useRef(null);
  const hasCompletedForecasts = forecasts.some(
    (entry) => !['analyzing', 'pending', 'awaiting-settlement'].includes(entry.status),
  );

  return (
    <section id="journal" className="journal-section" aria-labelledby="journal-heading">
      <div className="d-flex justify-content-between align-items-center gap-2 mb-2">
        <div className="d-flex gap-2 align-items-center">
          <h2 id="journal-heading" className="section-title mb-0">
            Forecast history
          </h2>
          <span className="count-chip">{forecasts.length}</span>
        </div>
        <Button
          ref={historyButton}
          size="sm"
          variant="outline-secondary"
          onClick={() => setShowHistory(true)}
        >
          View history
        </Button>
      </div>
      <JournalSummary
        summary={outcomeGroups?.kalshi ?? summary}
        compact
        current={Boolean(outcomeGroups)}
      />
      {forecasts.length ? (
        <ForecastTable forecasts={forecasts.slice(0, 1)} now={now} compact />
      ) : (
        <EmptyJournal />
      )}
      {hasCompletedForecasts && (
        <Button size="sm" variant="link" className="p-0 mt-1" onClick={() => setShowClear(true)}>
          Clear completed
        </Button>
      )}
      <Modal
        show={showHistory}
        onHide={() => setShowHistory(false)}
        className="tracker-modal"
        centered
        scrollable
        size="lg"
        aria-labelledby="history-dialog-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="history-dialog-heading" as="h2" className="h5">
            Forecast history
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Recorded forecasts and observed outcomes · Stored in this browser
          </p>
          {forecasts.length ? <ForecastTable forecasts={forecasts} now={now} /> : <EmptyJournal />}
          <div className="mt-3">
            <h3 className="h6">Kalshi · official results</h3>
            <JournalSummary summary={outcomeGroups?.kalshi ?? summary} />
          </div>
          <p className="small text-secondary mt-2 mb-0">
            Yes includes ties. Brier score is probability error; lower is better. Neutral calls and
            no-call windows are excluded from directional accuracy. No-call windows have no
            probability error score. Call coverage is the fraction of observation decisions that
            issued a fixed prediction. Personal, overlapping observations are not an independent
            validation set.
          </p>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setShowHistory(false)}>
            Close history
          </Button>
        </Modal.Footer>
      </Modal>
      <Modal
        show={showClear}
        onHide={() => setShowClear(false)}
        onExited={() => {
          if (!hasCompletedForecasts) historyButton.current?.focus();
        }}
        className="tracker-modal"
        centered
        aria-labelledby="clear-journal-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="clear-journal-heading" as="h2" className="h5">
            Clear completed forecasts?
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          This removes completed and no-call entries from this browser. Active observation, pending
          forecasts, and forecasts awaiting official settlement stay in place.
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setShowClear(false)}>
            Keep journal
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              onClear();
              setShowClear(false);
            }}
          >
            Clear completed
          </Button>
        </Modal.Footer>
      </Modal>
    </section>
  );
}
