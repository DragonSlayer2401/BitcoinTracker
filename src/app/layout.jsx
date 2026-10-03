import '@/theme.scss';
import StoreProvider from '@/state/StoreProvider';

export const metadata = {
  title: 'Kalshi Bitcoin Adviser | Paper Trading',
  description:
    'Internal Kalshi Bitcoin adviser with a simulated account, estimated trading decisions, live BRTI charts, and separate forecast research.',
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
