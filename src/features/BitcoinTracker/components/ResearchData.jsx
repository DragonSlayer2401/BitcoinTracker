import { useEffect, useState } from 'react';
import { Alert, Button, Modal } from 'react-bootstrap';
import { readEvidenceRows } from '../utils/evidenceStorage.utils';
import ResearchModelStatus from './ResearchData/ResearchModelStatus';
import ResearchPerformance from './ResearchData/ResearchPerformance';
import ResearchCollectionStatus from './ResearchData/ResearchCollectionStatus';
import {
  readResearchExport,
  requestResearch,
  runResearchLearning,
} from '@/services/research/research.client.service';

export default function ResearchData({ warning, researchStatus }) {
  const [isOpen, setIsOpen] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [exportedCount, setExportedCount] = useState(null);

  useEffect(() => {
    if (!isOpen) return;
    let isCurrent = true;
    setIsLoading(true);
    setError(null);
    requestResearch('analysis')
      .then((result) => {
        if (isCurrent) setReport(result);
      })
      .catch((readError) => {
        if (isCurrent) setError(readError.message);
      })
      .finally(() => {
        if (isCurrent) setIsLoading(false);
      });
    return () => {
      isCurrent = false;
    };
  }, [isOpen]);

  async function analyzeRecords() {
    setIsAnalyzing(true);
    setError(null);
    try {
      setReport(await runResearchLearning());
    } catch (analysisError) {
      setError(analysisError.message);
    } finally {
      setIsAnalyzing(false);
    }
  }

  async function exportEvidence(type) {
    setIsExporting(true);
    setError(null);
    setExportedCount(null);
    try {
      const rows = type === 'pending' ? await readEvidenceRows() : await readResearchExport(type);
      if (!rows.length) throw new Error('No records are available in this export yet.');
      const blob = new Blob([rows.map((row) => JSON.stringify(row)).join('\n') + '\n'], {
        type: 'application/x-ndjson',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'bitcoin-' + type + '-' + new Date().toISOString().slice(0, 10) + '.jsonl';
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
        scrollable
        size="lg"
        aria-labelledby="research-heading"
      >
        <Modal.Header closeButton>
          <Modal.Title id="research-heading" as="h2" className="h5">
            Forecast research and learning
          </Modal.Title>
        </Modal.Header>
        <Modal.Body>
          <ResearchModelStatus report={report} />
          <ResearchPerformance analysis={report?.analysis} />
          <ResearchCollectionStatus researchStatus={researchStatus} />
          {isLoading && (
            <p role="status" className="small mt-3 mb-0">
              Loading archive analysis…
            </p>
          )}
          {exportedCount !== null && (
            <Alert variant="success" role="status" className="mt-3 mb-0">
              Exported {exportedCount.toLocaleString()} records.
            </Alert>
          )}
          {(warning || error) && (
            <Alert variant="warning" className="mt-3 mb-0">
              {error || warning}{' '}
              <a href="/api/research/status" target="_blank" rel="noreferrer">
                Check archive access
              </a>
            </Alert>
          )}
        </Modal.Body>
        <Modal.Footer className="justify-content-start">
          <Button disabled={isAnalyzing || isLoading} onClick={analyzeRecords}>
            {isAnalyzing ? 'Analyzing…' : 'Analyze saved forecasts'}
          </Button>
          <Button
            variant="outline-secondary"
            disabled={isExporting}
            onClick={() => exportEvidence('evidence')}
          >
            Export research JSONL
          </Button>
          <Button
            variant="outline-secondary"
            disabled={isExporting}
            onClick={() => exportEvidence('forecasts')}
          >
            Export saved forecasts
          </Button>
          <Button
            variant="outline-secondary"
            disabled={isExporting}
            onClick={() => exportEvidence('pending')}
          >
            Export pending records
          </Button>
          <Button variant="outline-secondary" onClick={() => setIsOpen(false)}>
            Close research data
          </Button>
        </Modal.Footer>
      </Modal>
    </>
  );
}
