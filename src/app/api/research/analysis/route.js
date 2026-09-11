import { getLearningStatus } from '../../../../services/research/learning.service';
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
    return researchResponse(await getLearningStatus());
  } catch (error) {
    return researchErrorResponse(error);
  }
}
