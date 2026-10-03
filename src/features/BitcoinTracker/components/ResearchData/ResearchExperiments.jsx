import { useId, useState } from 'react';
import { Button, ButtonGroup, Table } from 'react-bootstrap';
import { formatDateTime, formatPercent } from '../../utils/format.utils';
import { RESEARCH_VARIANT_LABELS as variantLabels } from '../../utils/researchVariantConfig.utils';
const formatScore = (score) => (Number.isFinite(score) ? score.toFixed(3) : '—');
const formatDifference = (score) =>
  Number.isFinite(score) ? `${score > 0 ? '+' : ''}${score.toFixed(3)}` : '—';
const getChallengerLabel = (kind) =>
  variantLabels[kind] ?? variantLabels[`${kind}-candidate`] ?? kind;
const challengerStatusLabels = {
  active: 'Active',
  shadow: 'Future validation',
  collecting: 'Collecting future outcomes',
  'insufficient-data': 'Needs more training data',
  disabled: 'Suspended',
  'candidate-rejected': 'Not approved',
  ready: 'Ready for activation',
  confirmation: 'Final confirmation',
  'development-passed': 'Development checks passed',
  healthy: 'Healthy',
  monitoring: 'Monitoring',
  'unusable-evidence': 'Incomplete evidence',
  'data-incomplete': 'Incomplete evidence',
  'awaiting-collector': 'Waiting for collector',
  'awaiting-start': 'Scheduled future evaluation',
  'ready-to-train': 'Ready to fit',
};

const checkpointMinutes = [12, 9, 6, 3, 1];
const formatInterval = (interval) =>
  Array.isArray(interval) && interval.length === 2 && interval.every(Number.isFinite)
    ? `${formatPercent(interval[0])}–${formatPercent(interval[1])}`
    : '—';

function CheckpointValidation({ candidate }) {
  const evaluation = candidate.evaluation;
  if (!Array.isArray(evaluation?.checkpoints) || !evaluation.checkpoints.length) return null;
  const phase =
    evaluation.phase === 'confirmation' ? 'Final confirmation' : 'Development validation';
  return (
    <details className="mt-2">
      <summary>{phase} by countdown time</summary>
      <p className="my-2 text-secondary">
        Each row uses independent events at that capture time. Development selects which times
        advance; final confirmation uses a fresh group of later events before activation. Extra
        correct calls compares the candidate with choosing the current side on the same directional
        calls. A positive number means more correct calls; neutral estimates are excluded.
      </p>
      <Table responsive size="sm">
        <caption>{phase} checkpoint coverage and decisions</caption>
        <thead>
          <tr>
            <th scope="col">Time left</th>
            <th scope="col">Scored / required</th>
            <th scope="col">Extra correct calls</th>
            <th scope="col">Decision</th>
          </tr>
        </thead>
        <tbody>
          {checkpointMinutes.map((minutes) => {
            const row = evaluation.checkpoints.find((entry) => entry.checkpointMinutes === minutes);
            const paired = row?.candidate?.currentSideComparison;
            const additionalCorrect =
              Number.isSafeInteger(paired?.examples) &&
              paired.examples > 0 &&
              Number.isSafeInteger(paired?.additionalCorrect)
                ? paired.additionalCorrect
                : null;
            return (
              <tr key={minutes}>
                <th scope="row">{minutes}m</th>
                <td>
                  {row
                    ? `${row.scoredWindows ?? row.independentWindows ?? 0} / ${row.requiredWindows ?? evaluation.requiredWindows ?? '—'}`
                    : '—'}
                </td>
                <td>
                  {additionalCorrect === null ? (
                    '—'
                  ) : (
                    <>
                      {`${additionalCorrect > 0 ? '+' : ''}${additionalCorrect}`}
                      <span className="d-block text-secondary">{paired.examples} same events</span>
                    </>
                  )}
                </td>
                <td>
                  {row ? (
                    <>
                      {challengerStatusLabels[row.status] ?? row.status ?? 'Waiting'}
                      {row.reason && <span className="d-block text-secondary">{row.reason}</span>}
                    </>
                  ) : (
                    'Not nominated; uses baseline'
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
      {evaluation.checkpoints.map((checkpoint) => {
        const bins = Array.isArray(checkpoint.reliability) ? checkpoint.reliability : [];
        if (!bins.length) return null;
        const calibration = candidate.calibration?.checkpoints?.find(
          (entry) => entry.checkpointMinutes === checkpoint.checkpointMinutes,
        );
        return (
          <details key={checkpoint.checkpointMinutes} className="mt-2">
            <summary>{checkpoint.checkpointMinutes}m probability reliability</summary>
            {calibration && (
              <p className="my-2 text-secondary">
                {calibration.status === 'fitted'
                  ? 'Probability correction fitted'
                  : 'No probability correction fitted'}
                {' · '}
                {calibration.samples} earlier calibration events. The table below uses later
                validation outcomes.
              </p>
            )}
            <Table responsive size="sm">
              <caption>
                {checkpoint.checkpointMinutes}m future outcome reliability. Observed Yes frequency
                is not directional accuracy. The 95% ranges describe sampling uncertainty and may be
                wide for small groups.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Predicted Yes band</th>
                  <th scope="col">Events</th>
                  <th scope="col">Mean predicted Yes</th>
                  <th scope="col">Observed Yes</th>
                  <th scope="col">95% range</th>
                </tr>
              </thead>
              <tbody>
                {bins.map((bin, index) => (
                  <tr key={`${bin.lower}-${index}`}>
                    <th scope="row">
                      {formatPercent(bin.lower, 0)}–{formatPercent(bin.upper, 0)}
                    </th>
                    <td>{bin.samples ?? 0}</td>
                    <td>{formatPercent(bin.predictedProbability)}</td>
                    <td>{formatPercent(bin.observedFrequency)}</td>
                    <td>{formatInterval(bin.observedFrequencyInterval)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        );
      })}
    </details>
  );
}

export default function ResearchExperiments({ comparison, challengers }) {
  const headingId = useId();
  const [selectedMinutes, setSelectedMinutes] = useState(9);
  const checkpoints = comparison?.checkpoints ?? [];
  const selected =
    checkpoints.find((checkpoint) => checkpoint.checkpointMinutes === selectedMinutes) ??
    checkpoints.find((checkpoint) => checkpoint.checkpointMinutes === 6) ??
    checkpoints[0];
  const variants = Object.entries(selected?.variants ?? {});
  const hasScoredResults = variants.some(([, variant]) => variant.metrics?.examples > 0);
  const candidates = Array.isArray(challengers?.candidates) ? challengers.candidates : [];
  const validationReports = Array.isArray(challengers?.reports) ? challengers.reports : candidates;
  const active = challengers?.active;
  const activeName =
    active?.variantName ??
    active?.kind ??
    active?.id ??
    (typeof active === 'string' ? active : null);

  return (
    <section aria-labelledby={headingId} className="mb-3">
      <h3 id={headingId} className="h6">
        Prediction experiments
      </h3>
      <p className="small text-secondary">
        {!challengers ? (
          <>
            Challenger activation status is unavailable. These experimental comparisons do not
            select a model.
          </>
        ) : active ? (
          <>
            Active challenger: {getChallengerLabel(activeName) ?? 'validated model'}. Other
            candidate variants remain experimental.
          </>
        ) : (
          <>
            No challenger is currently in use. These experimental comparisons do not change
            displayed predictions.
          </>
        )}{' '}
        {comparison?.reason || 'Only predictions recorded before the outcome are scored.'}
      </p>
      {Array.isArray(active?.activation?.shadowEvaluation?.approvedCheckpoints) && (
        <p className="small">
          Active at approved checkpoints:{' '}
          <strong>
            {active.activation.shadowEvaluation.approvedCheckpoints
              .map((minutes) => `${minutes}m`)
              .join(', ') || 'none'}
          </strong>
          . Other countdown times use the baseline. Saved calls remain unchanged.
        </p>
      )}
      {checkpoints.length > 0 && (
        <div className="d-flex align-items-center flex-wrap gap-2 mb-2">
          <span className="small">Time remaining at capture</span>
          <ButtonGroup size="sm" aria-label="Comparison checkpoint">
            {checkpoints.map((checkpoint) => (
              <Button
                key={checkpoint.checkpointMinutes}
                type="button"
                variant={checkpoint === selected ? 'secondary' : 'outline-secondary'}
                aria-pressed={checkpoint === selected}
                onClick={() => setSelectedMinutes(checkpoint.checkpointMinutes)}
              >
                {checkpoint.checkpointMinutes}m
              </Button>
            ))}
          </ButtonGroup>
        </div>
      )}
      {!hasScoredResults ? (
        <p className="small" role="status">
          No verified experimental results
          {selected ? ` at the ${selected.checkpointMinutes}-minute checkpoint` : ''} yet.
        </p>
      ) : (
        <Table responsive size="sm" className="small">
          <caption>
            {selected.checkpointMinutes} minutes remaining · {selected.decisions ?? 0} recorded
            decisions. Model and current-side accuracy use the same directional calls; neutral
            estimates remain in probability scores. Extra correct calls is the model’s correct count
            minus the current-side count on those paired events. Lower Brier scores are better. Δ
            Brier compares each variant with combined pressure on the same events only; different
            sample counts are not directly comparable. Coverage is the share of decisions with an
            available estimate. Reversals caught and false warnings show counts over their
            respective totals. High accuracy late in the event does not by itself show an advantage.
          </caption>
          <thead>
            <tr>
              <th scope="col">Variant</th>
              <th scope="col">Scored</th>
              <th scope="col">Model accuracy</th>
              <th scope="col">Current side, same calls</th>
              <th scope="col">Extra correct calls</th>
              <th scope="col">Brier ↓</th>
              <th scope="col">Paired Δ Brier ↓</th>
              <th scope="col">Reversals caught</th>
              <th scope="col">False reversal warnings</th>
              <th scope="col">Coverage</th>
            </tr>
          </thead>
          <tbody>
            {variants.map(([name, variant]) => {
              const metrics = variant.metrics ?? {};
              const paired = variant.comparisons?.combined;
              const currentSide = metrics.currentSideComparison;
              return (
                <tr key={name}>
                  <th scope="row">{variantLabels[name] ?? name}</th>
                  <td>{metrics.examples ?? 0}</td>
                  <td>
                    {formatPercent(
                      currentSide
                        ? currentSide.modelAccuracy
                        : (metrics.directionalAccuracy ?? metrics.accuracy),
                    )}
                  </td>
                  <td>
                    {formatPercent(currentSide?.currentSideAccuracy)}
                    {Number.isInteger(currentSide?.examples) && (
                      <span className="d-block text-secondary">
                        {currentSide.examples} same events
                      </span>
                    )}
                  </td>
                  <td>
                    {Number.isInteger(currentSide?.additionalCorrect)
                      ? `${currentSide.additionalCorrect > 0 ? '+' : ''}${currentSide.additionalCorrect}`
                      : '—'}
                  </td>
                  <td>{formatScore(metrics.brier)}</td>
                  <td>
                    {name === 'combined' ? 'Reference' : formatDifference(paired?.delta?.brier)}
                    {name !== 'combined' && Number.isFinite(paired?.delta?.brier) && (
                      <span className="d-block text-secondary">
                        {paired.scoredPairs ?? 0} paired
                      </span>
                    )}
                  </td>
                  <td>
                    {Number.isInteger(metrics.reversalsCaught)
                      ? `${metrics.reversalsCaught} / ${metrics.reversals}`
                      : formatPercent(metrics.reversalRecall)}
                    {Number.isFinite(metrics.reversals) && (
                      <span className="d-block text-secondary">{metrics.reversals} reversals</span>
                    )}
                  </td>
                  <td>
                    {Number.isInteger(metrics.falseReversalWarnings)
                      ? `${metrics.falseReversalWarnings} / ${metrics.reversalAlerts}`
                      : formatPercent(metrics.reversalFalseAlarmRate)}
                    {Number.isFinite(metrics.reversalAlerts) && (
                      <span className="d-block text-secondary">
                        {metrics.reversalAlerts} alerts
                      </span>
                    )}
                  </td>
                  <td>{formatPercent(variant.callCoverage)}</td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}
      {(challengers?.reason || challengers?.status || validationReports.length > 0) && (
        <details className="small">
          <summary>
            Candidate validation · {candidates.length} candidate{candidates.length === 1 ? '' : 's'}
          </summary>
          {(challengers.reason || challengers.status) && (
            <p className="mt-2 mb-2">{challengers.reason ?? challengers.status}</p>
          )}
          {validationReports.length > 0 && (
            <ul className="mt-2 mb-0">
              {validationReports.map((candidate, index) => {
                const evaluation = candidate.evaluation;
                const scoredWindows = evaluation?.scoredWindows ?? evaluation?.independentWindows;
                const isReplacement =
                  active?.kind === candidate.kind && candidate.id && candidate.id !== active.id;
                const reasons = [
                  ...new Set([candidate.reason, ...(evaluation?.reasons ?? [])].filter(Boolean)),
                ];
                return (
                  <li
                    key={candidate.id ?? candidate.artifact?.id ?? `${candidate.kind}-${index}`}
                    className="mb-2"
                  >
                    <strong>
                      {getChallengerLabel(candidate.variantName ?? candidate.kind) ?? 'Candidate'}
                    </strong>
                    {candidate.status
                      ? ` · ${challengerStatusLabels[candidate.status] ?? candidate.status}`
                      : ''}
                    {(candidate.kind === 'directional-reversal' ||
                      (candidate.variantName ?? candidate.kind) ===
                        'directional-reversal-candidate') && (
                      <p className="mb-1 text-secondary">
                        Learns whether the final Kalshi result will be on the opposite side of the
                        target from the current price. It can change the predicted direction. It
                        stays experimental until it beats choosing the current side on future
                        events.
                      </p>
                    )}
                    {isReplacement && (
                      <span className="d-block">
                        Replacement candidate; the current active model remains in use.
                      </span>
                    )}
                    {candidate.readiness?.required && (
                      <p className="mb-1 text-secondary">
                        {candidate.readiness.status === 'waiting'
                          ? 'Collector check: waiting for a matching saved prediction.'
                          : candidate.readiness.status === 'scheduled'
                            ? `Collector check passed. Evaluation begins with the event starting ${formatDateTime(candidate.readiness.startsAt)}.`
                            : candidate.readiness.status === 'ready'
                              ? `Collector check passed. Evaluation started ${formatDateTime(candidate.readiness.startsAt)}.`
                              : 'Collector readiness has not been established.'}
                      </p>
                    )}
                    {(candidate.status === 'unusable-evidence' ||
                      evaluation?.failureCategory === 'evidence') && (
                      <p className="mb-1">
                        Required recordings were missing or incompatible, so this evaluation could
                        not establish performance. This is an evidence problem, not proof that the
                        candidate made worse predictions.
                      </p>
                    )}
                    {candidate.infrastructureRecovery && (
                      <p className="mb-1 text-secondary">
                        Recovering from incomplete evidence; the next evaluation must use a fresh
                        set of future events.
                      </p>
                    )}
                    {evaluation?.phase && (
                      <span className="d-block">
                        Stage:{' '}
                        {evaluation.phase === 'confirmation'
                          ? 'Final confirmation on fresh events'
                          : 'Development validation'}
                      </span>
                    )}
                    {Number.isSafeInteger(candidate.trial?.attemptNumber) && (
                      <span className="d-block text-secondary">
                        Confirmation attempt {candidate.trial.attemptNumber} ·{' '}
                        {candidate.trial.status}
                      </span>
                    )}
                    {reasons.length > 0 && <p className="mb-1">{reasons.join(' ')}</p>}
                    {Number.isFinite(candidate.counts?.independentWindows) && (
                      <span className="d-block text-secondary">
                        Training events:{' '}
                        {candidate.counts.primaryFitWindows ?? candidate.counts.independentWindows}
                        {Number.isFinite(challengers.requirements?.minimumTrainingWindows)
                          ? ` / ${challengers.requirements.minimumTrainingWindows}`
                          : ''}
                      </span>
                    )}
                    {Number.isFinite(candidate.counts?.calibrationWindows) && (
                      <span className="d-block text-secondary">
                        Separate calibration events: {candidate.counts.calibrationWindows} /{' '}
                        {candidate.counts.requiredCalibrationWindows}
                      </span>
                    )}
                    {Number.isFinite(scoredWindows) && (
                      <span className="d-block text-secondary">
                        Scored future events: {scoredWindows}
                        {Number.isFinite(evaluation.requiredWindows)
                          ? ` / ${evaluation.requiredWindows}`
                          : ''}
                        {Number.isFinite(evaluation.resolvedWindows)
                          ? ` · ${evaluation.resolvedWindows} resolved`
                          : ''}
                      </span>
                    )}
                    {candidate.monitoring && (
                      <p className="mb-1 text-secondary">
                        Active model monitoring:{' '}
                        {challengerStatusLabels[candidate.monitoring.status] ??
                          candidate.monitoring.status}
                        {Number.isFinite(candidate.monitoring.independentWindows)
                          ? ` · ${candidate.monitoring.independentWindows} later events`
                          : ''}
                        . {candidate.monitoring.reason}
                      </p>
                    )}
                    <CheckpointValidation candidate={candidate} />
                  </li>
                );
              })}
            </ul>
          )}
        </details>
      )}
    </section>
  );
}
