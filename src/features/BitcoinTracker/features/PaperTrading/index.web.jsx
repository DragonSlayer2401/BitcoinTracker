'use client';

import { useState } from 'react';
import { Alert, Button, Modal } from 'react-bootstrap';
import { useGetPaperTradingReportQuery } from '@/services/research/paperTrading/paperTrading.api';
import PaperTradingReport from './components/PaperTradingReport';

export default function PaperTrading() {
  const [isOpen, setIsOpen] = useState(false);
  const query = useGetPaperTradingReportQuery(undefined, {
    skip: !isOpen,
    pollingInterval: 10_000,
    skipPollingIfUnfocused: true,
    refetchOnMountOrArgChange: true,
    refetchOnFocus: true,
    refetchOnReconnect: true,
  });

  return (
    <>
      <Button size="sm" variant="outline-secondary" onClick={() => setIsOpen(true)}>
        Paper trading
      </Button>
      <Modal
        show={isOpen}
        onHide={() => setIsOpen(false)}
        className="tracker-modal"
        centered
        scrollable
        size="lg"
        aria-labelledby="paper-trading-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="paper-trading-heading" as="h2" className="h5">
            Paper trading results
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p className="small text-secondary">
            Experimental simulated trades using estimated fills from displayed liquidity. These are
            not actual trades, and displayed orders may disappear before execution. Results do not
            automatically promote a prediction model or enable live trading.
          </p>
          {query.isError && (
            <Alert variant="warning">
              {query.data
                ? 'The report could not be refreshed. Showing the last loaded results.'
                : 'The paper trading report is unavailable. Try refreshing.'}
            </Alert>
          )}
          {query.isLoading && !query.data && <p role="status">Loading paper trading results…</p>}
          {isOpen && query.data && <PaperTradingReport report={query.data} />}
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" disabled={query.isFetching} onClick={query.refetch}>
            {query.isFetching ? 'Refreshing…' : 'Refresh report'}
          </Button>
          <Button variant="outline-secondary" onClick={() => setIsOpen(false)}>
            Close paper trading
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
