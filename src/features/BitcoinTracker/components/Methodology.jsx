import { useState } from 'react';
import { Button, Modal } from 'react-bootstrap';
import Icon from './Icon';
import ResearchData from './ResearchData';
import KalshiModelRules from './KalshiModelRules';

export default function Methodology({ evidenceWarning, researchStatus }) {
  const [showRules, setShowRules] = useState(false);

  return (
    <section id="methodology" className="methodology-section" aria-label="Model and data rules">
      <div className="d-flex align-items-center gap-2 mb-2">
        <Icon name="info" />
        <h2 className="section-title mb-0">Model and data rules</h2>
      </div>
      <p className="small text-secondary mb-2">
        Predicts the selected Kalshi event. Trade pressure and the final-minute average shape the
        estimate. Accuracy remains unvalidated.
      </p>
      <div className="d-flex flex-wrap gap-2 mt-auto">
        <Button size="sm" variant="outline-secondary" onClick={() => setShowRules(true)}>
          View model rules
        </Button>
        <ResearchData warning={evidenceWarning} researchStatus={researchStatus} />
      </div>
      {evidenceWarning && (
        <span className="small text-warning mt-1" role="status">
          Research needs attention · see Research data
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
          <KalshiModelRules />
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
