import {
  getAdvisorConfigurationFromStore,
  saveAdvisorConfigurationToStore,
} from '@/services/research/tradingAdvisor/tradingAdvisor.service';
import {
  assertResearchRequest,
  readResearchRequestBody,
  researchResponse,
  researchErrorResponse,
} from '@/services/research/research.http';
import { ResearchDataError } from '@/services/research/research.validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function GET(request) {
  try {
    assertResearchRequest(request);
    if (new URL(request.url).search)
      throw new ResearchDataError('Setup takes no query parameters.');
    return researchResponse(await getAdvisorConfigurationFromStore());
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request) {
  try {
    assertResearchRequest(request, { write: true });
    if (new URL(request.url).search)
      throw new ResearchDataError('Setup takes no query parameters.');
    const body = await readResearchRequestBody(request);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 3 ||
      Object.keys(body).some(
        (key) => !['allocation', 'riskLevel', 'expectedRevision'].includes(key),
      )
    )
      throw new ResearchDataError('Send allocation, riskLevel and expectedRevision only.');
    return researchResponse(await saveAdvisorConfigurationToStore(body));
  } catch (error) {
    return researchErrorResponse(error);
  }
}
