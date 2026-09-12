import EarlyModelStatus from './EarlyModelStatus';

export default function ResearchModelStatus({ report }) {
  const counts = report?.training?.counts;
  const requirements = report?.requirements;
  const isEarlyModelInUse = Boolean(
    report?.active && report.early?.active?.id === report.active.id,
  );
  let modelDescription =
    'Kalshi settlement-average model. No learned adjustment is currently active.';
  if (isEarlyModelInUse) {
    modelDescription =
      `Early learning model ${report.active.id}. ` +
      (report.early.monitoring?.status === 'disabled'
        ? 'The adjustment is still active, but its latest outcome check failed. The next analysis cycle will suspend it.'
        : 'Its limited probability adjustment passed a fixed group of future events; unsupported conditions still use the settlement model.');
  } else if (report?.active) {
    modelDescription =
      `Learned model ${report.active.id}. ` +
      'It passed checks on later recorded windows before activation; unsupported conditions still use the settlement model.';
  } else if (report?.early?.monitoring?.status === 'disabled') {
    modelDescription =
      'Kalshi settlement-average model. The early adjustment is suspended after its latest outcome check.';
  }

  return (
    <>
      <h3 className="h6">Model in use</h3>
      <p className="small">
        {modelDescription} Fixed calls publish after up to three minutes of observation, with
        shorter waits for late entry and no minimum confidence threshold. Saved fixed calls stay
        unchanged when the model learns.
      </p>
      <EarlyModelStatus early={report?.early} isInUse={isEarlyModelInUse} />
      <h3 className="h6">Full model learning</h3>
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
    </>
  );
}
