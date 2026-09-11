import { readStoredEvidence } from '../../../../services/research/research.repository';
import {
  assertResearchRequest,
  getResearchRequestPage,
  researchErrorResponse,
  researchResponse,
} from '../../../../services/research/research.http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request) {
  try {
    assertResearchRequest(request);
    return researchResponse(await readStoredEvidence(getResearchRequestPage(request)));
  } catch (error) {
    return researchErrorResponse(error);
  }
}
