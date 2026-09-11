import { runLearningCycle } from '../../../../services/research/learning.service';
import {
  assertResearchRequest,
  readResearchRequestBody,
  researchErrorResponse,
  researchResponse,
} from '../../../../services/research/research.http';
import { ResearchDataError } from '../../../../services/research/research.validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request) {
  try {
    assertResearchRequest(request, { write: true });
    const body = await readResearchRequestBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length) {
      throw new ResearchDataError('Analysis uses saved evidence. Send an empty JSON object.');
    }
    return researchResponse(await runLearningCycle());
  } catch (error) {
    return researchErrorResponse(error);
  }
}
