import { useState } from 'react';
import { Alert, Button, Modal } from 'react-bootstrap';
import { formatDateTime } from '../../../utils/format.utils';
import { formatAdvisorMoney, formatAdvisorQuantity } from '../utils/advisorDisplay.utils';
import AdvisorStrategyTrials from './AdvisorStrategyTrials';
import AdvisorHistoryTrials from './AdvisorHistoryTrials';

function PerformanceValue({ label, value }) {
  return (
    <div className="col-6">
      <dt className="small text-secondary fw-normal">{label}</dt>
      <dd className="mb-0">{value}</dd>
    </div>
  );
}

export default function AdvisorPerformance({ report, isStale = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const performance = report?.performance;
  const hasComparison = performance?.pairedPositionCount > 0;
  return (
    <>
      <Button size="sm" variant="outline-secondary" onClick={() => setIsOpen(true)}>
        Performance
      </Button>
      <Modal
        show={isOpen}
        onHide={() => setIsOpen(false)}
        className="tracker-modal"
        centered
        scrollable
        aria-labelledby="advisor-performance-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="advisor-performance-heading" as="h2" className="h5">
            Paper adviser performance
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {isStale && (
            <Alert variant="warning" className="small">
              Outdated performance data. Showing last known results from{' '}
              {formatDateTime(report?.asOf)}.
            </Alert>
          )}
          {!performance ? (
            <p role="status">Performance data is unavailable.</p>
          ) : (
            <>
              <dl className="row g-3 mb-3">
                <PerformanceValue
                  label="Realized net P&L"
                  value={formatAdvisorMoney(
                    report.portfolio?.realizedPnl ?? performance.realizedPnl,
                  )}
                />
                <PerformanceValue
                  label="Estimated fees paid"
                  value={formatAdvisorMoney(performance.totalFees)}
                />
                {report.source && (
                  <>
                    <PerformanceValue
                      label="AI usage cost"
                      value={formatAdvisorMoney(performance.inferenceCost)}
                    />
                    <PerformanceValue
                      label="Net P&L after AI costs"
                      value={formatAdvisorMoney(performance.netProfit)}
                    />
                  </>
                )}
                <PerformanceValue
                  label="Largest realized drawdown"
                  value={formatAdvisorMoney(performance.maxRealizedDrawdown)}
                />
                <PerformanceValue
                  label="Official settlements"
                  value={formatAdvisorQuantity(performance.settledCount)}
                />
                <PerformanceValue
                  label="Simulated fills"
                  value={formatAdvisorQuantity(performance.fillCount)}
                />
                <PerformanceValue
                  label="Unfilled suggestions"
                  value={formatAdvisorQuantity(performance.noFillCount)}
                />
              </dl>
              <h3 className="h6">Did exits improve on holding?</h3>
              {hasComparison ? (
                <dl className="row g-3 mb-2">
                  <PerformanceValue
                    label="Same positions compared"
                    value={formatAdvisorQuantity(performance.pairedPositionCount)}
                  />
                  <PerformanceValue
                    label="Adviser net P&L"
                    value={formatAdvisorMoney(performance.pairedStrategyPnl)}
                  />
                  <PerformanceValue
                    label="Hold-to-settlement net P&L"
                    value={formatAdvisorMoney(performance.pairedHoldPnl)}
                  />
                  <PerformanceValue
                    label="Adviser advantage"
                    value={formatAdvisorMoney(performance.pairedAdvantage)}
                  />
                </dl>
              ) : (
                <p className="small">
                  No completed comparisons yet. Official outcomes are required before comparing each
                  closed position with holding it to settlement.
                </p>
              )}
              <p className="small text-secondary mb-2">
                Awaiting comparison: {formatAdvisorQuantity(performance.pendingComparisonCount)}{' '}
                positions. This comparison uses the same simulated entries and their actual official
                outcomes.
              </p>
              <p className="small text-secondary mb-0">
                All figures are simulated. Fees are included in net P&amp;L. Realized drawdown
                excludes changes in open positions, and a partial sale can realize a gain or loss
                before the position closes. These results do not validate a profitable live
                strategy.
              </p>
            </>
          )}
          {(!report?.source || report?.trials) && <AdvisorStrategyTrials trials={report?.trials} />}
          <AdvisorHistoryTrials trials={report?.historyTrials} />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setIsOpen(false)}>
            Close performance
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
