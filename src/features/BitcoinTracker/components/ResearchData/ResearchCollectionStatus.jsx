import { MAXIMUM_EVIDENCE_ROWS } from '../../utils/evidenceStorage.utils';
import { formatTime } from '../../utils/format.utils';

export default function ResearchCollectionStatus({ researchStatus }) {
  return (
    <>
      <h3 className="h6">Collection and storage</h3>
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
