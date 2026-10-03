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
  const exactCheckpoints = analysis?.byCheckpoint?.some((row) => row.examples > 0);

  return (
    <>
      <h3 className="h6">Recorded performance</h3>
      <p className="small text-secondary">
        {analysis?.explanation || 'Performance appears after verified outcomes arrive.'} The
        current-side benchmark predicts whichever side of the target the price occupies at capture.{' '}
        High accuracy near the end can happen because the price has little time left to cross the
        target. Extra correct calls shows whether the model actually beat that simple benchmark on
        the same events; a negative count means it did worse.
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
            caption="Kalshi Yes includes ties. Model and current-side accuracy use the same directional calls; parentheses show paired counts. Extra correct calls is model correct minus current-side correct. Neutral calls remain in Brier scores. Reversals caught shows correct warnings / actual reversals; false warnings shows incorrect warnings / all warnings."
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
              <dt>Reversals caught</dt>
              <dd>
                {Number.isInteger(metrics?.reversalsCaught) ? metrics.reversalsCaught : '—'} /{' '}
                {metrics?.reversals ?? 0} reversals ({formatPercent(metrics?.reversalRecall)})
              </dd>
            </div>
            <div>
              <dt>False reversal warnings</dt>
              <dd>
                {Number.isInteger(metrics?.falseReversalWarnings)
                  ? metrics.falseReversalWarnings
                  : '—'}{' '}
                / {metrics?.reversalAlerts ?? 0} warnings (
                {formatPercent(metrics?.reversalFalseAlarmRate)})
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
              rows={exactCheckpoints ? analysis.byCheckpoint : (analysis.byHorizon ?? [])}
              caption={
                exactCheckpoints
                  ? 'Exact countdown checkpoints. Model and current-side accuracy use the same directional events in each row. An event can appear at several times, so do not add the row counts together as independent events.'
                  : 'Independent windows grouped by time remaining at capture. Each current-side comparison uses the exact same events as that row’s directional model calls.'
              }
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
