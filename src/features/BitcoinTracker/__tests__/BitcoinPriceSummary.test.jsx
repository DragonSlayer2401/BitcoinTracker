import { render, screen } from '@testing-library/react';
import BitcoinPriceSummary from '../components/BitcoinPriceSummary';
import TrackerHeader from '../components/TrackerHeader';
import { getBenchmarkChartData } from '../utils/benchmarkChart.utils';
import { formatTime } from '../utils/format.utils';

const NOW = Date.UTC(2026, 8, 13, 12);
const benchmark = {
  available: true,
  status: 'live',
  samples: [
    { time: NOW - 900_000, price: 50_000 },
    { time: NOW, price: 50_100 },
  ],
  current: { time: NOW, price: 50_100 },
};

describe('BRTI price summary', () => {
  test('uses the index for the headline and fifteen-minute change', () => {
    render(<BitcoinPriceSummary benchmarkData={getBenchmarkChartData(benchmark, NOW)} />);
    expect(screen.getByRole('heading', { name: 'Bitcoin index price' })).toBeInTheDocument();
    expect(screen.getByText('CF Benchmarks BRTI · via Kalshi')).toBeInTheDocument();
    expect(screen.getByText('$50,100.00')).toBeInTheDocument();
    expect(screen.getByText(/0\.2%/)).toBeInTheDocument();
    expect(screen.getByText(`Index reading ${formatTime(NOW)}`)).toBeInTheDocument();
    expect(screen.queryByText(/Coinbase/)).not.toBeInTheDocument();
  });

  test('marks old index readings as delayed even if a Coinbase input is streaming', () => {
    const data = getBenchmarkChartData(benchmark, NOW + 6_000);
    render(
      <>
        <BitcoinPriceSummary benchmarkData={data} />
        <TrackerHeader now={NOW + 6_000} benchmarkData={data} hasStreamTicker />
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('BRTI delayed');
    expect(screen.getByText('$50,100.00')).toBeInTheDocument();
    expect(screen.getByText(/Index reading .* · delayed/)).toBeInTheDocument();
  });

  test('shows missing BRTI rather than substituting an exchange price or zero change', () => {
    const data = getBenchmarkChartData(undefined, NOW);
    render(
      <>
        <BitcoinPriceSummary benchmarkData={data} />
        <TrackerHeader now={NOW} benchmarkData={data} hasStreamTicker />
      </>,
    );
    expect(screen.getByRole('status')).toHaveTextContent('BRTI unavailable');
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByText(/~15m/)).not.toBeInTheDocument();
  });
});
