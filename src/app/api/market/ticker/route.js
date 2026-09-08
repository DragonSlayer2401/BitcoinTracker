import {
  fetchCoinbaseTicker,
  MarketDataError,
} from '../../../../services/coinbase/coinbase.service';

export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

export async function GET() {
  try {
    return Response.json(await fetchCoinbaseTicker(), { headers });
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof MarketDataError
            ? error.message
            : 'Market data is temporarily unavailable.',
      },
      { status: error instanceof MarketDataError ? error.status : 502, headers },
    );
  }
}
