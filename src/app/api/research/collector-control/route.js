import {
  getCollectorControlStatus,
  startManagedCollector,
  stopManagedCollector,
} from '@/services/research/collectorControl/collectorControl.service';
import {
  assertResearchRequest,
  readResearchRequestBody,
  researchErrorResponse,
  researchResponse,
} from '@/services/research/research.http';
import { ResearchDataError } from '@/services/research/research.validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function assertLocalRequest(request, write = false) {
  assertResearchRequest(request, { write });
  const url = new URL(request.url);
  if (
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    process.env.VERCEL ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NETLIFY
  ) {
    throw new ResearchDataError('Collector controls are available only on the local app.', 403);
  }
  if (url.search) throw new ResearchDataError('Collector controls take no query parameters.');
}

export async function GET(request) {
  try {
    assertLocalRequest(request);
    return researchResponse(await getCollectorControlStatus());
  } catch (error) {
    return researchErrorResponse(error);
  }
}

export async function POST(request) {
  try {
    assertLocalRequest(request, true);
    const body = await readResearchRequestBody(request);
    if (
      !body ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !['start', 'stop'].includes(body.action)
    ) {
      throw new ResearchDataError('Choose only a start or stop collection action.');
    }
    return researchResponse(
      await (body.action === 'start' ? startManagedCollector() : stopManagedCollector()),
    );
  } catch (error) {
    return researchErrorResponse(error);
  }
}
