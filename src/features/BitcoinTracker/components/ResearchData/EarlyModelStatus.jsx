import { formatPercent } from '../../utils/format.utils';
import ResearchAccuracyTable from './ResearchAccuracyTable';

export default function EarlyModelStatus({ early, isInUse }) {
  if (!early) return null;
  const { training, candidate, monitoring, requirements } = early;
  const shadow = early.shadow ?? early.active?.activation?.shadowEvaluation;
  const isDisabled = monitoring?.status === 'disabled';
  const isSuspensionPending = isInUse && isDisabled;
  const isRejected = Boolean(shadow?.evaluationComplete && !shadow.eligibleForPromotion);
  let status = 'Collecting events';
  if (isSuspensionPending) status = 'Suspension pending';
  else if (isInUse) status = 'Active limited adjustment';
  else if (training?.status === 'superseded') status = 'Full model in use';
  else if (isDisabled) status = 'Adjustment suspended';
  else if (candidate) {
    status = isRejected ? 'Candidate not approved' : 'Testing candidate';
    if (shadow?.eligibleForPromotion) status = 'Validation passed; awaiting activation';
  } else if (training?.status === 'ready-to-train') status = 'Ready to train';
  const comparisons = [
    { label: 'Early model future validation', result: shadow },
    { label: 'Early model after activation', result: monitoring },
  ].filter(({ result }) => result?.candidate && result?.current);
  const displayedReasons = [candidate ? shadow?.reasons?.join(' ') : '', monitoring?.reason]
    .filter(Boolean)
    .join(' ');
  const hasSeparateTrainingReason = training?.reason && !displayedReasons.includes(training.reason);

  return (
    <section className="mb-3" aria-labelledby="early-learning-heading">
      <h3 id="early-learning-heading" className="h6">
        Early learning
      </h3>
      <p className="small mb-2">
        <strong>{status}.</strong> This learns a small correction to the settlement model’s
        percentages from saved outcomes.
        {requirements && (
          <>
            {' '}
            Once approved, it blends in {formatPercent(requirements.blendWeight, 0)} of that
            correction and can change a probability by at most{' '}
            {Math.round(requirements.maximumProbabilityAdjustment * 1000) / 10} percentage points in
            either direction.
          </>
        )}
      </p>
      {candidate && (
        <p className="small">
          Candidate {candidate.id} is experimental and does not change displayed predictions.
          {shadow?.reasons?.length ? ' ' + shadow.reasons.join(' ') : ''}
        </p>
      )}
      {hasSeparateTrainingReason && <p className="small text-secondary">{training.reason}</p>}
      {requirements && (
        <>
          <dl className="market-data-grid small">
            <div>
              <dt>Available early training events</dt>
              <dd>
                {training?.counts?.independentWindows ?? training?.counts?.training ?? 0} /{' '}
                {requirements.minimumTrainingWindows}
              </dd>
            </div>
            {training?.counts?.classes && (
              <>
                <div>
                  <dt>Yes training events</dt>
                  <dd>
                    {training.counts.classes.above ?? 0} / {requirements.minimumClassExamples}
                  </dd>
                </div>
                <div>
                  <dt>No training events</dt>
                  <dd>
                    {training.counts.classes.below ?? 0} / {requirements.minimumClassExamples}
                  </dd>
                </div>
              </>
            )}
            <div>
              <dt>Selected future events</dt>
              <dd>
                {shadow?.eligibleWindows ?? shadow?.independentWindows ?? 0} /{' '}
                {requirements.minimumShadowWindows}
              </dd>
            </div>
            <div>
              <dt>Scored validation predictions</dt>
              <dd>
                {shadow?.independentWindows ?? 0} / {requirements.minimumShadowWindows}
              </dd>
            </div>
            {Number.isFinite(shadow?.modelUses) && (
              <div>
                <dt>Validation adjustments used</dt>
                <dd>
                  {shadow.modelUses} / {requirements.minimumShadowModelUses}
                </dd>
              </div>
            )}
          </dl>
          <p className="small text-secondary">
            Each event counts once, regardless of how many records it produces. Training needs at
            least {requirements.minimumClassExamples} Yes and {requirements.minimumClassExamples} No
            outcomes. The first {requirements.minimumShadowWindows} eligible future events form a
            fixed validation group; repeated checks cannot extend a failed group until it passes.
          </p>
        </>
      )}
      {monitoring && (
        <p className="small" role="status">
          {isSuspensionPending
            ? 'Suspension pending. The next analysis cycle will disable this adjustment. '
            : isDisabled
              ? 'Early adjustment suspended. '
              : 'After-activation check: '}
          {monitoring.reason}
          {requirements && !isDisabled && (
            <>
              {' '}
              ({monitoring.independentWindows ?? 0} / {requirements.minimumMonitoringWindows}{' '}
              events.)
            </>
          )}
        </p>
      )}
      {comparisons.map(({ label, result }) => (
        <ResearchAccuracyTable
          key={label}
          rows={[
            { label: `${label}: early adjustment`, ...result.candidate },
            { label: `${label}: settlement baseline`, ...result.current },
            ...(result.benchmark
              ? [{ label: `${label}: current-side benchmark`, ...result.benchmark }]
              : []),
          ]}
          caption={`${label}. Recorded future outcomes only. Lower Brier means lower probability error; these results do not guarantee future accuracy.`}
        />
      ))}
    </section>
  );
}
