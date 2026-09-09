import { useState } from 'react';
import { Alert, Button, Modal } from 'react-bootstrap';
import { readEvidenceRows, MAXIMUM_EVIDENCE_ROWS } from '../utils/evidenceStorage.utils';

export default function ResearchData({ warning }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState(null);
  const [exportedCount, setExportedCount] = useState(null);

  async function exportEvidence() {
    setIsExporting(true);
    setError(null);
    setExportedCount(null);
    try {
      const rows = await readEvidenceRows();
      if (!rows.length) throw new Error('No observation evidence has been recorded yet.');
      const blob = new Blob([rows.map((row) => JSON.stringify(row)).join('\n') + '\n'], {
        type: 'application/x-ndjson',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `bitcoin-research-${new Date().toISOString().slice(0, 10)}.jsonl`;
      link.click();
      setExportedCount(rows.length);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (exportError) {
      setError(exportError.message);
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="outline-secondary" onClick={() => setIsOpen(true)}>
        Research data
      </Button>
      <Modal
        show={isOpen}
        onHide={() => setIsOpen(false)}
        className="tracker-modal"
        centered
        aria-labelledby="research-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="research-heading" as="h2" className="h5">
            Prospective research data
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <p>
            New forecast windows record their saved target, input features, trade flow, liquidity,
            data-quality flags, model probabilities, publication decisions, and verified outcomes.
            Observations are sampled every five seconds while the fixed call is being evaluated.
          </p>
          <p>
            Records append in this browser and are never silently overwritten or backfilled. Storage
            stops at {MAXIMUM_EVIDENCE_ROWS.toLocaleString()} rows. Export JSONL for chronological
            evaluation; this device-local record is not an immutable central audit or proof of
            predictive accuracy.
          </p>
          <p className="mb-0">
            Minute-candle backtests cannot reproduce every trade, spread, outage, or order-book
            change. These prospective records allow those additions to be tested separately.
          </p>
          {exportedCount !== null && (
            <Alert variant="success" role="status" className="mt-3 mb-0">
              Exported {exportedCount.toLocaleString()} research records.
            </Alert>
          )}
          {(warning || error) && (
            <Alert variant="warning" className="mt-3 mb-0">
              {error || warning}
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer>
          <Button disabled={isExporting} onClick={exportEvidence}>
            {isExporting ? 'Exporting…' : 'Export research JSONL'}
          </Button>
          <Button variant="outline-secondary" onClick={() => setIsOpen(false)}>
            Close research data
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
