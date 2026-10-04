'use client';

import { useState } from 'react';
import { Alert, Button, Modal } from 'react-bootstrap';
import { useGetTradingAdvisorReportQuery } from '@/services/research/tradingAdvisor/tradingAdvisor.api';
import { formatCountdown, formatDateTime, formatPrice, formatTime } from '../../utils/format.utils';
import AdvisorAction from './components/AdvisorAction';
import AdvisorPositions from './components/AdvisorPositions';
import AdvisorPerformance from './components/AdvisorPerformance';
import AdvisorRisk from './components/AdvisorRisk';
import AdvisorSetup from './components/AdvisorSetup';
import { formatAdvisorMoney, hasFreshAdvisorReport } from './utils/advisorDisplay.utils';
import './TradingAdvisor.scss';

export default function TradingAdvisor({ market, now, chart, research, hasMarketError = false }) {
  const [showResearch, setShowResearch] = useState(false);
  const query = useGetTradingAdvisorReportQuery(undefined, {
    pollingInterval: 5000,
    skipPollingIfUnfocused: true,
    refetchOnFocus: true,
    refetchOnReconnect: true,
    refetchOnMountOrArgChange: true,
  });
  const report = query.data;
  const portfolio = report?.portfolio;
  const policy = report?.policy;
  // A response can arrive between clock ticks; use its client receipt time as well.
  const reportTime = Number.isFinite(now) ? Math.max(now, query.fulfilledTimeStamp ?? now) : now;
  const isAccountStale = Boolean(
    report && (query.isError || query.error || !hasFreshAdvisorReport(report, reportTime)),
  );
  const hasCurrentMarket =
    market && Number.isFinite(now) && market.startsAt <= now && market.expiresAt > now;

  return (
    <>
      <div className="advisor-workspace">
        <section
          className="advisor-account dashboard-panel"
          aria-labelledby="advisor-account-heading"
        >
          <div className="advisor-account-header d-flex flex-column gap-2 mb-2">
            <div className="d-flex align-items-center justify-content-between flex-wrap gap-2">
              <h2 id="advisor-account-heading" className="section-title mb-0">
                Simulated account
              </h2>
              <span className="small text-secondary">Paper adviser · no real orders</span>
            </div>
            <div className="d-flex align-items-center flex-wrap gap-2">
              <AdvisorPerformance report={report} isStale={isAccountStale} />
              <AdvisorRisk report={report} now={reportTime} isStale={isAccountStale} />
              <AdvisorSetup onSaved={query.refetch} />
              <Button
                size="sm"
                variant="outline-secondary"
                aria-label="Research & market details"
                onClick={() => setShowResearch(true)}
              >
                Research
              </Button>
            </div>
          </div>
          {report && (
            <p
              className={`advisor-account-time small mb-2 ${isAccountStale ? 'text-warning' : 'text-secondary'}`}
              role={isAccountStale ? 'status' : undefined}
            >
              <strong>{isAccountStale ? 'Outdated account data' : 'Account snapshot'}</strong>
              {' · '}
              {formatDateTime(report.asOf)}
              {isAccountStale &&
                ' · Balances and positions are last known. Refresh before relying on them.'}
            </p>
          )}
          <dl className="advisor-account-values mb-0">
            <div>
              <dt>Total budget</dt>
              <dd>{formatAdvisorMoney(policy?.totalBudget ?? policy?.initialBankroll ?? 100)}</dd>
            </div>
            <div>
              <dt>Available cash</dt>
              <dd>{formatAdvisorMoney(portfolio?.cash)}</dd>
            </div>
            <div>
              <dt>Open risk</dt>
              <dd>
                {formatAdvisorMoney(portfolio?.openRisk)}{' '}
                <span>/ {formatAdvisorMoney(policy?.maxOpenRisk)}</span>
              </dd>
            </div>
            <div>
              <dt>Pending reserve</dt>
              <dd>{formatAdvisorMoney(portfolio?.reservedCapital)}</dd>
            </div>
            <div>
              <dt>Realized net P&amp;L</dt>
              <dd
                className={
                  portfolio?.realizedPnl > 0
                    ? 'advisor-gain'
                    : portfolio?.realizedPnl < 0
                      ? 'advisor-loss'
                      : ''
                }
              >
                {formatAdvisorMoney(portfolio?.realizedPnl)}
              </dd>
            </div>
          </dl>
        </section>

        <div className="advisor-chart dashboard-panel">
          <div className="advisor-event d-flex align-items-center justify-content-between flex-wrap gap-2 mb-2">
            <div className="small d-flex align-items-baseline flex-wrap gap-2">
              <span className="text-secondary">Current Kalshi event</span>
              <strong className="advisor-target">
                Target {formatPrice(hasCurrentMarket ? market.target : null)}
              </strong>
            </div>
            <div className="d-flex align-items-center flex-wrap justify-content-end gap-2">
              <span
                className="advisor-countdown"
                role="timer"
                aria-label="Current Kalshi event closes in"
              >
                {hasCurrentMarket ? formatCountdown(market.expiresAt - now) : '—'}
              </span>
              <span className="small text-secondary">
                {hasCurrentMarket
                  ? `Closes ${formatTime(market.expiresAt)}`
                  : 'Waiting for an open event'}
              </span>
            </div>
          </div>
          {chart}
        </div>

        <AdvisorAction
          report={report}
          market={hasCurrentMarket ? market : null}
          now={now}
          isLoading={query.isLoading}
          isError={query.isError || isAccountStale || hasMarketError}
          onRefresh={query.refetch}
          isRefreshing={query.isFetching}
        />
        <AdvisorPositions
          portfolio={portfolio}
          recentActivity={report?.recentActivity}
          isStale={isAccountStale}
          asOf={report?.asOf}
        />
      </div>
      <Modal
        show={showResearch}
        onHide={() => setShowResearch(false)}
        className="tracker-modal advisor-research-modal"
        size="xl"
        scrollable
        centered
        aria-labelledby="advisor-research-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="advisor-research-heading" as="h2" className="h5">
            Research &amp; market details
          </Modal.Title>
        </Modal.Header>
        <Modal.Body className="bitcoin-tracker">
          <p className="small text-secondary mb-3">
            Forecasts and market signals support the adviser. Saved prediction research remains
            separate from simulated positions and trade results.
          </p>
          {query.isError && (
            <Alert variant="warning">The latest adviser report could not be loaded.</Alert>
          )}
          <div className="advisor-research-content">{research}</div>
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setShowResearch(false)}>
            Close research details
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
