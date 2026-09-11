import '@/theme.scss';
import StoreProvider from '@/state/StoreProvider';

export const metadata = {
  title: 'Bitcoin Tracker | Internal Monitor',
  description:
    'Internal BTC/USD monitor with live market data, scheduled 15-minute forecasts, and a local outcome journal.',
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" data-bs-theme="dark">
      {/* Grammarly can add body attributes before hydration; child mismatches remain checked. */}
      <body suppressHydrationWarning>
        <StoreProvider>{children}</StoreProvider>
      </body>
    </html>
  );
}
