import { MAXIMUM_EVIDENCE_ROWS } from '../../utils/evidenceStorage.utils';
import { formatTime } from '../../utils/format.utils';
import useClock from '../../hooks/useClock';
import { COLLECTOR_HEALTH_POLICY } from '../../utils/collectorHealth.utils';

export default function ResearchCollectionStatus({ researchStatus, collectorHealth }) {
  const clock = useClock();
  const now = clock ?? collectorHealth?.generatedAt;
  const collectors = (collectorHealth?.collectors ?? []).map((collector) => ({
    ...collector,
    status:
      ['running', 'starting'].includes(collector.status) &&
      now - collector.heartbeatAt > COLLECTOR_HEALTH_POLICY.staleAfterMs
        ? 'stale'
        : collector.status,
  }));
  const active = collectors.filter((collector) =>
    ['running', 'starting'].includes(collector.status),
  );
  const status = active.some((collector) => collector.status === 'running')
    ? 'running'
    : active.length
      ? 'starting'
      : (collectors[0]?.status ?? 'unknown');
  const labels = {
    running: 'Running',
    starting: 'Starting',
    stale: 'Heartbeat overdue',
    stopped: 'Stopped',
    error: 'Stopped after an error',
    unknown: 'Running status unknown',
  };
  const counts = collectorHealth?.counts;
  return (
    <>
      <h3 className="h6">Collection and storage</h3>
      <section aria-label="Collector health" className="border rounded p-3 mb-3 small">
        <h4 className="h6 mb-2">Persistent collector</h4>
        <p className="mb-2">
          <strong>{labels[status]}</strong>
          {active.length > 0 &&
            ` · ${active.length} active collector${active.length === 1 ? '' : 's'}`}
          {' · '}Last heartbeat:{' '}
          {collectorHealth?.lastHeartbeatAt
            ? formatTime(collectorHealth.lastHeartbeatAt)
            : 'not received'}
        </p>
        {status === 'unknown' && (
          <p className="text-secondary mb-2">
            Archive activity alone cannot confirm a running collector. Older collectors do not send
            heartbeats.
          </p>
        )}
        {status === 'stale' && (
          <p className="text-secondary mb-2">
            No heartbeat arrived within 90 seconds. The collector may be stopped, disconnected, or
            unable to save health updates.
          </p>
        )}
        {collectorHealth?.needsRestart && (
          <p className="text-warning mb-2">
            Older collector code or research generation detected. Restart any collector that has not
            loaded the current code.
          </p>
        )}
        {collectors.length > 0 && (
          <div className="table-responsive">
            <table className="table table-sm align-middle mb-2">
              <caption className="small">
                Feed freshness is measured at each collector’s last heartbeat.
              </caption>
              <thead>
                <tr>
                  <th scope="col">Collector</th>
                  <th scope="col">Code</th>
                  <th scope="col">Feeds at heartbeat</th>
                </tr>
              </thead>
              <tbody>
                {collectors.slice(0, 5).map((collector, index) => (
                  <tr key={`${collector.startedAt}-${index}`}>
                    <th scope="row">
                      {index + 1} · {labels[collector.status]}
                    </th>
                    <td>
                      {collector.isCurrentVersion ? 'Current' : 'Outdated'}
                      <br />
                      <small>{collector.codeVersion}</small>
                    </td>
                    <td>
                      {collector.progress?.failureMessage && (
                        <p className="text-warning mb-1">
                          Recording issue: {collector.progress.failureMessage}
                        </p>
                      )}
                      {collector.progress?.evidenceOverdue && (
                        <p className="text-warning mb-1">
                          No evidence saved for over 15 minutes despite fresh contract data. A
                          running heartbeat does not confirm successful recording.
                        </p>
                      )}
                      BRTI: {collector.feeds.benchmarkAt.status} · Spot:{' '}
                      {collector.feeds.spotAt.status}
                      <br />
                      Futures: {collector.feeds.futuresAt.status} · Contracts:{' '}
                      {collector.feeds.marketAt.status}
                      {collector.recording && (
                        <>
                          <br />
                          New models saved this session: {
                            collector.recording.savedCandidates
                          } / {collector.recording.loadedCandidates} loaded
                          {collector.recording.loadedCandidates >
                            collector.recording.savedCandidates &&
                            ' · waiting for a matching checkpoint capture'}
                          <br />
                          Kalshi prices used in research:{' '}
                          {collector.recording.lastMarketQuoteAt
                            ? formatTime(collector.recording.lastMarketQuoteAt)
                            : 'not yet recorded this session'}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {counts && (
          <p className="mb-2">
            Last 24 hours, known contracts: {counts.capturedCheckpoints} / {counts.dueCheckpoints}{' '}
            checkpoints captured
            {' · '}
            {counts.missedCheckpoints} missed or withheld.
            <br />
            Forward labels: {counts.forwardObserved} observed · {counts.forwardMissing} missing ·{' '}
            {counts.forwardPending} due and pending.
          </p>
        )}
        {collectorHealth?.evidence?.latestDecisionAt && (
          <p className="text-secondary mb-0">
            Latest automatic archive decision:{' '}
            {formatTime(collectorHealth.evidence.latestDecisionAt)}
            {' · '}
            {collectorHealth.evidence.researchVersion ?? 'generation unrecorded'}.
          </p>
        )}
      </section>
      <p className="small">
        Automatic research follows real Kalshi targets and close times, with captures at 12, 9, 6, 3
        and 1 minute remaining. Each event is one independent outcome. Missed checkpoints stay
        missing.
      </p>
      <p className="small">
        The server archive keeps Kalshi forecasts and captured inputs. Candidates learn from past
        automatic events, then must pass their model’s checks on recorded future outcomes before
        activation. Early and full models use the separate requirements shown above.
      </p>
      <p className="small text-secondary mb-0">
        Collection needs this page running or the optional persistent collector. Last archive sync:{' '}
        {researchStatus?.lastSyncedAt ? formatTime(researchStatus.lastSyncedAt) : 'waiting'}. Upload
        failures retain up to {MAXIMUM_EVIDENCE_ROWS.toLocaleString()} pending evidence rows on this
        device. Clearing the visible journal does not erase the server archive.
      </p>
    </>
  );
}
