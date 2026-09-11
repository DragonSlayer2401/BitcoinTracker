import { getResearchStatus } from '../../../../services/research/research.repository';
import {
  assertResearchRequest,
  researchErrorResponse,
  researchResponse,
} from '../../../../services/research/research.http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request) {
  try {
    assertResearchRequest(request);
    return researchResponse(await getResearchStatus());
  } catch (error) {
    return researchErrorResponse(error);
  }
}
