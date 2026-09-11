import {
  readForecastSnapshotEvents,
  readStoredEvidence,
} from '../../../../services/research/research.repository';
import {
  assertResearchRequest,
  getResearchRequestPage,
  researchErrorResponse,
  researchResponse,
} from '../../../../services/research/research.http';
import { ResearchDataError } from '../../../../services/research/research.validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request) {
  try {
    assertResearchRequest(request);
    const type = new URL(request.url).searchParams.get('type') ?? 'evidence';
    if (!['evidence', 'forecasts'].includes(type))
      throw new ResearchDataError('Export type must be evidence or forecasts.');
    const read = type === 'evidence' ? readStoredEvidence : readForecastSnapshotEvents;
    return researchResponse({ type, ...(await read(getResearchRequestPage(request))) });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
