# Continuous Kalshi research collector

The optional Node process records real KXBTC15M contracts while the browser is closed. It uses Coinbase trades, liquidity and candles as inputs, and official Kalshi results as outcomes. Public inputs need no API key. Entitled BRTI access is optional and configured through the same server environment as the app.

Use Node 24 and install project dependencies, including development dependencies:

```sh
pnpm research:collect --once
pnpm research:collect
```

The launcher loads `.env.local`, then `.env`; existing environment values take precedence. Local storage defaults to `data/bitcoin-research.db`; configured Turso credentials let the collector and hosted app share an archive.

## Collection rules

The recorder follows actual published targets and close times. It captures once at each 12/9/6/3/1-minute checkpoint, within five seconds of that checkpoint. Late starts do not invent earlier forecasts. Unknown targets or invalid data produce missing-checkpoint metadata. Finalized results are fetched later for the exact contract.

All checkpoints and overlapping collectors for an event are grouped in evaluation. Multiple collectors do not produce extra independent examples. Every five minutes, outside capture boundaries, the collector can analyze records and evaluate candidate models. Candidates still need the retrospective and future shadow checks described in [outcome learning](forecast-learning.md).

`--once` waits briefly for market inputs, performs one recorder step, checks storage and exits. It is a connectivity/storage check, not verification of a complete event. A continuous collector needs an awake, connected machine.

## Durable state

State is stored in `data/kalshi-collector-state.json`. It retains collector identity, immutable contracts, pending checkpoints, official results and exact unacknowledged evidence. Each update flushes a temporary file before atomic replacement. Brief Windows file-lock failures receive bounded retries; unrecoverable failures stop collection visibly instead of silently losing state.

Database inserts are idempotent. On restart, pending rows replay before new observation. Non-Kalshi state files are rejected, and server ingest guards reject legacy records.

A process lock prevents two local processes sharing the same state file. After an unclean shutdown, verify the recorded process is stopped before removing only that state's `.lock` file. Preserve the JSON state. An isolated check can use `--state-file=data/kalshi-smoke.json`.

## Hosting and access

A serverless Next.js request cannot host a permanent WebSocket. Run continuous collection as a separate persistent process if it must operate while the page is closed. No collector service or recurring task is installed automatically.

Existing local hardware needs no additional public market-data subscription. Hosting/database charges depend on the provider. Official BRTI requires Kalshi entitlement; its API documentation does not publish an access price. See [benchmark setup](kalshi.md). Never expose private keys or database tokens to the browser.
