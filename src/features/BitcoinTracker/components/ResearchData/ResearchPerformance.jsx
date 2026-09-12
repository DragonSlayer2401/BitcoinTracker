import { Table } from 'react-bootstrap';
import { formatPercent } from '../../utils/format.utils';
import ResearchAccuracyTable from './ResearchAccuracyTable';

function getInputSourceLabel(row) {
  const priceHistory =
    row.featureInputSource === 'cf-brti-history' ? 'BRTI history' : 'Coinbase history';
  const referencePrice = row.referenceSource === 'cf-brti' ? 'BRTI price' : 'proxy price';
  return `${priceHistory} · ${referencePrice} · ${row.baselineModelVersion}`;
}

export default function ResearchPerformance({ analysis }) {
  const metrics = analysis?.metrics;
  const bins = metrics?.calibrationBins?.filter((bin) => bin.count) ?? [];

  return (
    <>
      <h3 className="h6">Recorded performance</h3>
      <p className="small text-secondary">
        {analysis?.explanation || 'Performance appears after verified outcomes arrive.'} The
        current-side benchmark predicts whichever side of the target the price occupies at capture.
      </p>
      {analysis && (
        <>
          <ResearchAccuracyTable
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
            <ResearchAccuracyTable
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
            <ResearchAccuracyTable
              rows={analysis.byHorizon ?? []}
              caption="Independent windows grouped by time remaining at capture."
            />
            <ResearchAccuracyTable
              rows={(analysis.byModel ?? []).map((row) => ({
                ...row,
                label: row.modelId ?? row.modelVersion,
              }))}
              caption="Model versions are scored separately."
            />
            {Boolean(analysis.byInputSource?.length) && (
              <ResearchAccuracyTable
                rows={analysis.byInputSource.map((row) => ({
                  ...row,
                  label: getInputSourceLabel(row),
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
                  YES probabilities compared with how often Kalshi settled YES. Small groups remain
                  uncertain.
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
    </>
  );
}
