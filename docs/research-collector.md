# Continuous Kalshi research collector

The optional Node process records real KXBTC15M contracts while the browser is closed. It uses Coinbase trades, liquidity and candles, plus Bybit BTCUSDT perpetual executions and reported liquidations as inputs, and official Kalshi results as outcomes. Public inputs need no API key. Entitled BRTI access is optional and configured through the same server environment as the app.

Use Node 24 and install project dependencies, including development dependencies:

```sh
pnpm research:collect --once
pnpm research:collect
```

The launcher loads `.env.local`, then `.env`; existing environment values take precedence. Local storage defaults to `data/bitcoin-research.db`; configured Turso credentials let the collector and hosted app share an archive.

The collector and browser use the same [futures-aware calculation](derivatives.md). Futures data is optional: unavailable or warming inputs retain the existing price/spot-pressure calculation. After updating this code, stop an already-running collector with Ctrl+C and restart it to load the new calculation. Existing saved calls and pending outcomes remain intact.

## Kalshi API budget

The collector, app and `pnpm kalshi:check` share the same durable limiter for every Kalshi GET.
Configured Kalshi credentials authenticate all of those reads. The account's limit and cost
policy refreshes after five minutes; the tracker uses at most half the reported read rate and
capacity, capped at 100 tokens per second and 100 tokens of capacity. It reserves at least
50 tokens per BRTI request and 10 per other read, or more if the discovered endpoint cost
requires it. These are quota tokens, not fees. The collector sends no Kalshi write requests.
Its research inserts and limiter updates are writes to our database, not Kalshi's write bucket.
See the [Kalshi limit design and official references](kalshi.md#shared-api-limits).

Local processes launched from this project share `data/kalshi-rate-limits.db`, separately from
the research archive and collector state file. When running on multiple machines or serverless
instances, point **every app and collector using the same Kalshi account** to the same remote
store with `KALSHI_RATE_LIMIT_DATABASE_URL` and `KALSHI_RATE_LIMIT_AUTH_TOKEN`. Existing remote
`TURSO_DATABASE_URL`/`TURSO_AUTH_TOKEN` values are used when those overrides are absent. Detected
serverless deployments require a remote shared store; an unavailable or locked limiter pauses
Kalshi requests. Starting more collectors does not grant more quota.

Individual reads have a three-second admission deadline; delayed permissions expire before
dispatch, even if storage takes longer to answer. A Kalshi 429 applies a shared exponential
pause starting at two seconds and increasing to 60 seconds, honoring a longer `Retry-After`
when present. The transport reports the temporary failure rather than rapidly resending it;
normal collection can try again after the pause. Checkpoints still obey their capture windows:
data delayed beyond a checkpoint is recorded as missing, never fabricated. Other applications
using the account or changes to Kalshi's limits can still cause throttling outside this
deployment's control.

## Collection rules

The recorder follows actual published targets and close times. It captures once at each 12/9/6/3/1-minute checkpoint, within five seconds of that checkpoint. Late starts do not invent earlier forecasts. Unknown targets or invalid data produce missing-checkpoint metadata. Finalized results are fetched later for the exact contract.

All checkpoints and overlapping collectors for an event are grouped in evaluation. Multiple
collectors do not produce extra independent examples. Every five minutes, outside capture
boundaries, the collector can analyze records and evaluate candidate models. Early learning can
fit a small correction after 40 eligible events, then must pass a fixed group of 40 future events
before it changes predictions. An approved correction is limited to five percentage points;
continued outcome checks can suspend it. Full model training keeps its larger, separate
training/calibration/test and future-validation requirements. Neither model activates merely
because it has enough records. See [outcome learning](forecast-learning.md) for the requirements.

`--once` waits briefly for market inputs, performs one recorder step, checks storage and exits. It is a connectivity/storage check, not verification of a complete event. A continuous collector needs an awake, connected machine.

## Durable state

State is stored in `data/kalshi-collector-state.json`. It retains collector identity, immutable contracts, pending checkpoints, official results and exact unacknowledged evidence. Each update flushes a temporary file before atomic replacement. Brief Windows file-lock failures receive bounded retries; unrecoverable failures stop collection visibly instead of silently losing state.

Database inserts are idempotent. On restart, pending rows replay before new observation. Non-Kalshi state files are rejected, and server ingest guards reject legacy records.

A process lock prevents two local processes sharing the same state file. After an unclean shutdown, verify the recorded process is stopped before removing only that state's `.lock` file. Preserve the JSON state. An isolated check can use `--state-file=data/kalshi-smoke.json`.

## Hosting and access

A serverless Next.js request cannot host a permanent WebSocket. Run continuous collection as a separate persistent process if it must operate while the page is closed. No collector service or recurring task is installed automatically.

Existing local hardware needs no additional public market-data subscription. Hosting/database charges depend on the provider. Official BRTI requires Kalshi entitlement; its API documentation does not publish an access price. See [benchmark setup](kalshi.md). Never expose private keys or database tokens to the browser.
