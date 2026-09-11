import { useEffect, useState } from 'react';
import { Alert, Button, Modal, Table } from 'react-bootstrap';
import { readEvidenceRows, MAXIMUM_EVIDENCE_ROWS } from '../utils/evidenceStorage.utils';
import { formatPercent, formatTime } from '../utils/format.utils';
import {
  readResearchExport,
  requestResearch,
  runResearchLearning,
} from '@/services/research/research.client.service';

const number = (value) => (Number.isFinite(value) ? value.toFixed(3) : '—');

function AccuracyTable({ rows, caption }) {
  return (
    <Table responsive size="sm" className="small">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Group</th>
          <th scope="col">Scored</th>
          <th scope="col">Accuracy</th>
          <th scope="col">Current side</th>
          <th scope="col">Brier ↓</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.label}>
            <th scope="row">{row.label}</th>
            <td>{row.examples ?? 0}</td>
            <td>
              {formatPercent(row.directionalAccuracy)} ({row.directionalCalls ?? 0})
            </td>
            <td>{formatPercent(row.currentSideAccuracy)}</td>
            <td>{number(row.brier)}</td>
          </tr>
        ))}
      </tbody>
    </Table>
  );
}

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

  const analysis = report?.analysis;
  const metrics = analysis?.metrics;
  const counts = report?.training?.counts;
  const requirements = report?.requirements;
  const bins = metrics?.calibrationBins?.filter((bin) => bin.count) ?? [];

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
          <h3 className="h6">Model in use</h3>
          <p className="small">
            {report?.active
              ? 'Learned model ' +
                report.active.id +
                '. It passed checks on later recorded windows before activation; unsupported conditions still use the settlement model.'
              : 'Kalshi settlement-average model. A learned replacement has not passed the required future-outcome checks yet.'}{' '}
            Fixed calls publish after up to three minutes of observation, with shorter waits for
            late entry and no minimum confidence threshold.
          </p>
          <p className="small text-secondary">
            {report?.training?.reason || 'Collecting saved forecasts and market conditions.'}
          </p>
          {counts?.pipeline && (
            <p className="small text-secondary">
              Training price history:{' '}
              {counts.pipeline.featureInputSource === 'cf-brti-history' ? 'BRTI' : 'Coinbase'}
              {' · '}
              {counts.pipeline.baselineModelVersion}. Counts below use this model version and these
              price sources only.
            </p>
          )}
          {counts && requirements && (
            <dl className="market-data-grid small">
              <div>
                <dt>Training windows</dt>
                <dd>
                  {counts.training} / {requirements.minimumTrainingWindows}
                </dd>
              </div>
              <div>
                <dt>Calibration windows</dt>
                <dd>
                  {counts.calibration} / {requirements.minimumCalibrationWindows}
                </dd>
              </div>
              <div>
                <dt>Later test windows</dt>
                <dd>
                  {counts.test} / {requirements.minimumTestWindows}
                </dd>
              </div>
              <div>
                <dt>Future shadow windows</dt>
                <dd>
                  {report.shadow?.independentWindows ?? 0} / {requirements.minimumShadowWindows}
                </dd>
              </div>
            </dl>
          )}
          {report?.candidate && (
            <p className="small">
              Candidate {report.candidate.id} is being tested alongside the current model.{' '}
              {report.shadow?.reasons?.join(' ')}
            </p>
          )}
          {report?.lastRun?.reason && (
            <p className="small" role="status">
              Last analysis: {report.lastRun.reason}
            </p>
          )}
          <h3 className="h6">Recorded performance</h3>
          <p className="small text-secondary">
            {analysis?.explanation || 'Performance appears after verified outcomes arrive.'} The
            current-side benchmark predicts whichever side of the target the price occupies at
            capture.
          </p>
          {analysis && (
            <>
              <AccuracyTable
                rows={[
                  {
                    label:
                      analysis.primaryCohort === 'kalshi-background'
                        ? 'Automatic windows'
                        : 'Manual windows',
                    ...metrics,
                  },
                  ...(analysis.savedJournal?.groups ?? []),
                ]}
                caption="Kalshi Yes includes ties. Accuracy excludes neutral calls; parentheses show directional call counts. Brier includes neutral probabilities."
              />
              {analysis.marketBenchmark && (
                <AccuracyTable
                  rows={[
                    { label: 'Kalshi market midpoint', ...analysis.marketBenchmark },
                    { label: 'Model on matching events', ...analysis.marketBenchmark.matchedModel },
                  ]}
                  caption="Only events with fresh matching Kalshi quotes at capture. The midpoint is a comparison, not an executable price."
                />
              )}
              <dl className="market-data-grid small">
                <div>
                  <dt>Call coverage</dt>
                  <dd>{formatPercent(analysis.callCoverage)}</dd>
                </div>
                <div>
                  <dt>Verified outcome coverage</dt>
                  <dd>{formatPercent(analysis.outcomeCoverage)}</dd>
                </div>
                <div>
                  <dt>Reversals detected</dt>
                  <dd>
                    {formatPercent(metrics?.reversalRecall)} ({metrics?.reversals ?? 0} reversals)
                  </dd>
                </div>
                <div>
                  <dt>False reversal alerts</dt>
                  <dd>
                    {formatPercent(metrics?.reversalFalseAlarmRate)} ({metrics?.reversalAlerts ?? 0}{' '}
                    alerts)
                  </dd>
                </div>
                <div>
                  <dt>80% range coverage</dt>
                  <dd>
                    {formatPercent(metrics?.central80IntervalCoverage)} (
                    {metrics?.intervalExamples ?? 0} ranges)
                  </dd>
                </div>
                <div>
                  <dt>Calibration error</dt>
                  <dd>{formatPercent(metrics?.expectedCalibrationError)}</dd>
                </div>
              </dl>
              <details className="small mb-3">
                <summary>Results by remaining time, model and price source</summary>
                <AccuracyTable
                  rows={analysis.byHorizon ?? []}
                  caption="Independent windows grouped by time remaining at capture."
                />
                <AccuracyTable
                  rows={(analysis.byModel ?? []).map((row) => ({
                    ...row,
                    label: row.modelId ?? row.modelVersion,
                  }))}
                  caption="Model versions are scored separately."
                />
                {Boolean(analysis.byInputSource?.length) && (
                  <AccuracyTable
                    rows={analysis.byInputSource.map((row) => ({
                      ...row,
                      label: `${row.featureInputSource === 'cf-brti-history' ? 'BRTI history' : 'Coinbase history'} · ${row.referenceSource === 'cf-brti' ? 'BRTI price' : 'proxy price'} · ${row.baselineModelVersion}`,
                    }))}
                    caption="Each model version and price source has its own results; older proxy results do not establish BRTI accuracy."
                  />
                )}
              </details>
              <details className="small mb-3">
                <summary>Do the percentages match actual outcomes?</summary>
                {bins.length ? (
                  <Table responsive size="sm">
                    <caption>
                      YES probabilities compared with how often Kalshi settled YES. Small groups
                      remain uncertain.
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Predicted YES</th>
                        <th scope="col">Actual YES</th>
                        <th scope="col">Windows</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bins.map((bin) => (
                        <tr key={bin.lower}>
                          <td>{formatPercent(bin.meanProbability)}</td>
                          <td>{formatPercent(bin.observedAboveRate)}</td>
                          <td>{bin.count}</td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <p className="mt-2">No scored probability groups yet.</p>
                )}
              </details>
            </>
          )}
          <h3 className="h6">Collection and storage</h3>
          <p className="small">
            Automatic research follows real Kalshi targets and close times, with captures at 12, 9,
            6, 3 and 1 minute remaining. Each event is one independent outcome. Missed checkpoints
            stay missing.
          </p>
          <p className="small">
            The server archive keeps Kalshi forecasts and captured inputs. Candidates learn from
            automatic windows, use separate later data to adjust their percentages, and must improve
            on the current model and simple benchmarks on future windows before activation.
          </p>
          <p className="small text-secondary mb-0">
            Collection needs this page running or the optional persistent collector. Last archive
            sync:{' '}
            {researchStatus?.lastSyncedAt ? formatTime(researchStatus.lastSyncedAt) : 'waiting'}.
            Upload failures retain up to {MAXIMUM_EVIDENCE_ROWS.toLocaleString()} pending evidence
            rows on this device. Clearing the visible journal does not erase the server archive.
          </p>
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
