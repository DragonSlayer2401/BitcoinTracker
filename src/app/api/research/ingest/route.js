import {
  persistEvidenceRows,
  persistForecastSnapshots,
} from '../../../../services/research/research.repository';
import {
  assertResearchRequest,
  readResearchRequestBody,
  researchErrorResponse,
  researchResponse,
} from '../../../../services/research/research.http';
import {
  ResearchDataError,
  validateResearchBatch,
  validateEvidenceRow,
  validateForecastSnapshot,
} from '../../../../services/research/research.validation';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export async function POST(request) {
  try {
    assertResearchRequest(request, { write: true });
    const body = await readResearchRequestBody(request);
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => !['evidence', 'forecasts'].includes(key))
    ) {
      throw new ResearchDataError('Send a research batch with evidence and forecasts arrays.');
    }
    const evidence = body.evidence === undefined ? [] : body.evidence;
    const forecasts = body.forecasts === undefined ? [] : body.forecasts;
    validateResearchBatch(evidence);
    validateResearchBatch(forecasts);
    evidence.forEach(validateEvidenceRow);
    forecasts.forEach(validateForecastSnapshot);
    return researchResponse({
      evidence: await persistEvidenceRows(evidence),
      forecasts: await persistForecastSnapshots(forecasts),
    });
  } catch (error) {
    return researchErrorResponse(error);
  }
}
