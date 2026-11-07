'use client';

import { useState } from 'react';
import { Button, Modal } from 'react-bootstrap';
import PaperTrading from './features/PaperTrading/PaperTrading';
import TradingAdvisor from './features/TradingAdvisor/TradingAdvisor';

const SimulatedTrading = ({ market, now, hasMarketError }) => {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <Button
        size="sm"
        variant="outline-secondary"
        aria-label="Paper trading research"
        onClick={() => setIsOpen(true)}
      >
        Research
      </Button>
      <Modal
        show={isOpen}
        onHide={() => setIsOpen(false)}
        className="tracker-modal advisor-research-modal"
        size="xl"
        scrollable
        centered
        aria-labelledby="paper-trading-research-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="paper-trading-research-heading" as="h2" className="h5">
            Paper trading research
          </Modal.Title>
        </Modal.Header>
        <Modal.Body className="bitcoin-tracker">
          <div className="d-flex justify-content-end mb-2">
            <PaperTrading />
          </div>
          <TradingAdvisor market={market} now={now} hasMarketError={hasMarketError} />
        </Modal.Body>
        <Modal.Footer>
          <Button variant="outline-secondary" onClick={() => setIsOpen(false)}>
            Close research
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
};

export default SimulatedTrading;
