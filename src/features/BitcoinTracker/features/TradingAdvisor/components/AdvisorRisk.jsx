import { useState } from 'react';
import { Alert, Button, Modal, Table } from 'react-bootstrap';
import { formatDateTime } from '../../../utils/format.utils';
import { formatAdvisorMoney, formatAdvisorQuantity } from '../utils/advisorDisplay.utils';

const statusLabels = {
  priced: 'Sale estimated',
  awaiting_settlement: 'Awaiting official settlement',
  book_unavailable: 'No fresh order book',
  shared_depth_unavailable: 'Shared liquidity needs a combined estimate',
  insufficient_execution_depth: 'Not enough buyers for the whole position',
  book_unavailable_or_stale: 'No fresh order book',
  book_unavailable_or_noncausal: 'No timely order book',
  fees_unavailable: 'Exit fees unavailable',
};

function RiskValue({ label, value }) {
  return (
    <div className="col-6">
      <dt className="small text-secondary fw-normal">{label}</dt>
      <dd className="mb-0">{value}</dd>
    </div>
  );
}

/** Separate market-value observations from cash and the frozen entry policy. */
export default function AdvisorRisk({ report, now, isStale = false }) {
  const [isOpen, setIsOpen] = useState(false);
  const valuation = report?.risk?.valuation;
  const history = report?.risk?.history;
  const isCurrent = Boolean(
    !isStale &&
    report?.risk?.isCurrent &&
    Number.isFinite(now) &&
    Number.isFinite(valuation?.observedAt) &&
    Number.isFinite(valuation?.validUntil) &&
    now < valuation.validUntil &&
    valuation.observedAt <= now &&
    now - valuation.observedAt < 30000,
  );
  const isComplete = isCurrent && valuation.complete;
  const currentValue = (value) => formatAdvisorMoney(isComplete ? value : null);
  return (
    <>
      <Button size="sm" variant="outline-secondary" onClick={() => setIsOpen(true)}>
        Account risk
      </Button>
      <Modal
        show={isOpen}
        onHide={() => setIsOpen(false)}
        className="tracker-modal"
        centered
        scrollable
        aria-labelledby="advisor-risk-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="advisor-risk-heading" as="h2" className="h5">
            Paper account value &amp; risk
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          {!isCurrent ? (
            <Alert variant="warning" className="small">
              A current sale estimate is unavailable. Unknown position values are not treated as
              zero. {valuation && `Last observation: ${formatDateTime(valuation.observedAt)}.`}
            </Alert>
          ) : !valuation.complete ? (
            <Alert variant="warning" className="small">
              Some positions cannot be fully priced. The account total stays unknown until every
              holding has usable prices or an official settlement.
            </Alert>
          ) : (
            <p className="small text-secondary">
              Sale estimate observed {formatDateTime(valuation.observedAt)}. Prices can change
              before execution.
            </p>
          )}
          <dl className="row g-3 mb-3">
            <RiskValue
              label="Estimated account value"
              value={currentValue(valuation?.executableEquity)}
            />
            <RiskValue
              label="Total P&L vs keeping cash"
              value={currentValue(valuation?.totalMarkedPnl)}
            />
            <RiskValue label="Unrealized P&L" value={currentValue(valuation?.unrealizedPnl)} />
            <RiskValue
              label="Estimated net sale proceeds"
              value={currentValue(valuation?.liquidationValue)}
            />
            <RiskValue
              label="Capital still at risk"
              value={formatAdvisorMoney(isStale ? null : report?.portfolio?.openRisk)}
            />
            <RiskValue
              label="Cash left if all exposure loses"
              value={formatAdvisorMoney(isStale ? null : report?.portfolio?.cash)}
            />
          </dl>
          <p className="small text-secondary">
            Account value includes available cash, cash reserved for unfilled buys, and estimated
            proceeds from selling all holdings after exit fees and slippage. Reserved sell
            quantities are counted once. All open BTC positions and pending buys count toward
            potential loss; they are not assumed to protect one another.
          </p>
          <p className="small">
            The {formatAdvisorMoney(report?.policy?.maxDailyLoss)} daily realized-loss trigger stops
            new entries. It does not cap losses on positions already open or automatically sell
            them. These new measurements do not change the saved trading policy.
          </p>
          {valuation?.positions?.length > 0 && (
            <Table responsive size="sm" className="small">
              <caption>Holdings at the last valuation</caption>
              <thead>
                <tr>
                  <th scope="col">Holding</th>
                  <th scope="col">Contracts</th>
                  <th scope="col">Net sale estimate</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {valuation.positions.map((position) => (
                  <tr key={position.positionId}>
                    <th scope="row" className="fw-normal text-break">
                      {report.portfolio?.positions.find((item) => item.id === position.positionId)
                        ?.contract?.ticker ?? 'Recorded holding'}
                    </th>
                    <td>{formatAdvisorQuantity(position.quantity)}</td>
                    <td>{formatAdvisorMoney(isCurrent ? position.netProceeds : null)}</td>
                    <td>
                      {isCurrent
                        ? (statusLabels[position.status] ?? 'Cannot fully price this holding')
                        : 'Outdated observation'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
          <h3 className="h6">Observed account declines</h3>
          {!history ? (
            <p className="small">Risk tracking starts with the next recorded adviser update.</p>
          ) : (
            <>
              <dl className="row g-3 mb-2">
                <RiskValue
                  label="Current observed drawdown"
                  value={currentValue(history.drawdown)}
                />
                <RiskValue
                  label="Largest observed drawdown"
                  value={formatAdvisorMoney(history.maxDrawdown)}
                />
                <RiskValue
                  label="Complete observations"
                  value={formatAdvisorQuantity(history.completeCount)}
                />
                <RiskValue
                  label="Incomplete observations"
                  value={formatAdvisorQuantity(history.incompleteCount)}
                />
              </dl>
              <p className="small text-secondary mb-0">
                Tracking since {formatDateTime(history.startedAt)}; last complete observation{' '}
                {formatDateTime(history.lastCompleteAt)}. Drawdown measures the decline from the
                greater of the starting bankroll and the highest complete observed account value.
                Missing observations and moves between samples can hide larger declines. Earlier
                market values are not reconstructed.
              </p>
            </>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setIsOpen(false)}>
            Close account risk
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
