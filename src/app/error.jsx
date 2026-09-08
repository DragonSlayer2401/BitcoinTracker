'use client';

import { Button } from 'react-bootstrap';

export default function ErrorPage({ reset }) {
  return (
    <main className="container py-5">
      <h1>The tracker needs to reconnect.</h1>
      <p>We couldn’t display the market data. Your saved forecasts remain in this browser.</p>
      <Button onClick={reset}>Try again</Button>
    </main>
  );
}
