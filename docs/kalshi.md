# Kalshi Bitcoin event integration

The tracker follows real `KXBTC15M` contracts. It loads the target from `floor_strike`,
the 15-minute window from `open_time` and `close_time`, and the contract's actual rules.
`expected_expiration_time` and `expiration_time` are not countdown deadlines.
The series API supplies the matching-engine `exchange_index`; it is not hard-coded.

The supported rules specify a simple 60-second CF Benchmarks BRTI average, rounded to two
decimal places. YES includes equality. Unknown rule templates are labeled unsupported, and
unpublished targets stay pending. Future events can be armed before their targets are published.

## Data access and cost

Kalshi targets, upcoming schedules, quotes and finalized results use public GET endpoints.
The app's public-data mode needs no account key. When credentials are configured, all Kalshi
reads are authenticated and budgeted against the reported account limits. The app continues
estimating with a clearly labeled Coinbase proxy when the official benchmark is unavailable.
That proxy is not settlement data.

To enable the official benchmark:

1. Use a production Kalshi API key and its matching private RSA key. The tracker connects to
   the production API, so demo credentials do not apply.
2. Open `.env.local` in the project root (beside `package.json`). If missing, create it from
   `.env.example`. Set `KALSHI_API_KEY_ID` to the **Key ID**, not the descriptive name you gave
   the key. Set `KALSHI_PRIVATE_KEY` to the **entire contents** of the downloaded key file,
   including its BEGIN and END lines. Keep the surrounding double quotes and original line
   breaks. For example, with placeholder values only:

   ```dotenv
   KALSHI_API_KEY_ID=your-production-key-id
   KALSHI_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----
   paste-the-original-key-lines-here
   -----END RSA PRIVATE KEY-----"
   ```

   Preserve your file's exact header: `BEGIN PRIVATE KEY` and `BEGIN RSA PRIVATE KEY` are both
   accepted. Literal `\n` line separators also work. Do not paste a filename or file path into
   `KALSHI_PRIVATE_KEY`.

3. Save the file and run `pnpm kalshi:check` from the project directory (Node.js 24 recommended).
   This reads the benchmark using the same signing, rate limiter and validation as the app.
   When needed, it first reads account limits and endpoint costs. It prints the feed status
   without exposing credentials and does not write to the research database. It does update
   the shared local or remote rate-limit store to account for its API requests.
   `live` confirms fresh official data; all other statuses exit with code 1:

   | Status           | Next step                                                                                                                     |
   | ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
   | `not-configured` | Fill in both environment variables.                                                                                           |
   | `unauthorized`   | Check that the production Key ID and private key match; ask Kalshi about benchmark entitlement if they do.                    |
   | `stale`          | Access returned old readings. Retry; stale data will not be treated as a live benchmark.                                      |
   | `unavailable`    | Read the sanitized reason. An invalid signing key needs its full PEM pasted again; network or feed failures may need a retry. |

4. Restart `pnpm dev` and any running `pnpm research:collect` process. For a hosted deployment,
   set these two server-side environment variables in the hosting provider and redeploy.
   The app automatically uses fresh BRTI when available and displays **BRTI benchmark connected**.
   `/api/kalshi/benchmark` shows the running server's feed status; if it differs from the CLI,
   restart the server and check for environment variables already set in its launch shell.

The check command loads `.env.local`, then `.env`, preserving variables already set in its shell.
It works without the development server running. A successful check confirms current feed access,
not forecasting accuracy. See Kalshi's [API key guide](https://docs.kalshi.com/getting_started/api_keys)
for the Key ID and downloaded private-key fields.

Never put private keys in `NEXT_PUBLIC_` variables, browser code, source control, or chat.
Remote access to the credentialed benchmark uses the same internal access policy as research
endpoints: configure `RESEARCH_API_USERNAME`/`RESEARCH_API_PASSWORD`, HTTPS and deployment access
controls. Signed requests are limited to supported KXBTC15M market/series reads, the fixed BRTI
read resource and account limit/cost metadata. No trading API is exposed.

Kalshi's [public market guide](https://docs.kalshi.com/getting_started/quick_start_market_data)
requires no authentication for market data. Its
[benchmark passthrough documentation](https://docs.kalshi.com/cfbenchmarks/rest-passthrough)
requires Kalshi credentials and appropriate entitlement, with no separate CF Benchmarks key.
It does not publish an entitlement price, so any charge and redistribution rights must be
confirmed with Kalshi. Its “50 tokens” is request quota, not a dollar fee. No service was bought.
These access notes were checked September 10, 2026. Verify your account's live access using
`pnpm kalshi:check` after entering your credentials.

## Shared API limits

Every outbound Kalshi request from the app, collector and check command uses one GET-only
transport. The resource allowlist rejects unsupported paths and query parameters. The tracker
makes **zero Kalshi writes**: saving forecasts and rate-limit reservations in our database does
not spend Kalshi's write quota or place an order.

With credentials, the limiter refreshes the account's reported read/write limits and endpoint
costs when its five-minute policy expires. It uses at most half the reported read refill rate
and capacity, with an additional ceiling of 100 tokens per second and 100 tokens of capacity.
Each request reserves the greatest applicable endpoint cost and default cost, with floors of
50 tokens for BRTI and 10 for other reads. Discovery requests also consume the shared budget;
starting another process or rotating a key does not reset it. Public mode uses a conservative
Basic-tier budget and still reads the current endpoint costs. See Kalshi's
[token-bucket rules](https://docs.kalshi.com/getting_started/rate_limits),
[account limits](https://docs.kalshi.com/api-reference/account/get-account-api-limits) and
[endpoint costs](https://docs.kalshi.com/api-reference/account/list-non-default-endpoint-costs).

Reservations and provider-requested pauses persist in `data/kalshi-rate-limits.db` for local
runs. This separate file lets the app and collector coordinate without adding writes to the
research archive. Run both from the same project directory. For multiple machines or hosted
instances, configure every process using the same Kalshi account with the **same remote
rate-limit database**:

```dotenv
KALSHI_RATE_LIMIT_DATABASE_URL=libsql://your-shared-database.turso.io
KALSHI_RATE_LIMIT_AUTH_TOKEN=your-database-token
```

These optional overrides take precedence over an existing remote `TURSO_DATABASE_URL` and
`TURSO_AUTH_TOKEN`; that remote archive can also hold the limiter's separate table. Detected
serverless deployments require a remote shared store. If its configuration, connection,
database lock or saved policy prevents safe accounting, Kalshi reads pause instead of bypassing
the limiter. Keep database tokens server-side and out of source control.

Requests have a three-second admission deadline. A successful reservation that takes more than
250 milliseconds to return is also discarded without sending or refunding its tokens, so a
paused worker cannot dispatch an old permission. Slow storage may delay the error response,
but never extends permission to send. A Kalshi 429 pauses all workers sharing the store, with exponential backoff from two
seconds up to 60 seconds; a longer `Retry-After` is honored if provided. Requests are not blindly
retried in a tight loop. The limiter controls this deployment's traffic; it cannot guarantee
that other applications using the account, separate stores or a provider-side limit change
will never cause a 429. Keep every tracker instance on the same store and allow room for other
account activity.

## Probability and fixed calls

The experimental `kalshi-brti-average-v2` model measures price movement from the settlement
index itself when at least 16 complete, consecutive BRTI minutes are available. Each completed
minute requires genuine readings at all 60 seconds in `(minute start, minute end]`. The
[existing values endpoint](https://docs.cfbenchmarks.com/api/rest/values/) supplies an hour of
recent observations; the app now retains the full hour and reports missing seconds. It does
not reconstruct missing seconds as observed prices. No additional subscription or historical
endpoint is needed. Requests from concurrent callers share an in-flight request and a one-second
cache per credential pair; cache reuse does not refresh the data's receipt timestamp.

The volatility estimate uses weighted squared returns, short- and longer-window movement,
intraminute ranges, and the latest unfinished-minute move. A smooth selloff/rally still contributes
to uncertainty rather than disappearing when its mean return is subtracted. Sudden moves widen
uncertainty; valid context flags do not veto fixed calls. Unsupported extreme movements remain
unavailable instead of silently substituting quiet Coinbase volatility.

Coinbase executed trade pressure remains an optional directional input. Its effect is bounded
by the chosen index volatility. Returns and acceleration from BRTI feed the versioned learning
features, without simply extrapolating a recent trend. Volume, spread and liquidity remain
explicitly Coinbase data; the index has no executed trading volume. Missing optional exchange
feeds do not prevent a native BRTI estimate, fixed call, automatic capture or reversal-risk display.
Short or gapped BRTI history uses the existing labeled Coinbase-candle fallback if that data is valid.

The model projects a distribution for the arithmetic average. The 60 readings share correlated price
movement. Real readings already received stay fixed; missing elapsed readings retain uncertainty
through conditional price-path distributions. A moment-matched lognormal approximation yields
the YES/NO probabilities. The cent-rounding threshold is included. Uncertainty starts from the
actual reference timestamp. Current trade pressure affects future seconds only; it cannot change
readings already received or the modeled gap between earlier observations.

The sampling convention follows the documented
[Kalshi streaming helper](https://docs.kalshi.com/websockets/cfbenchmarks-value):
`(deadline - 60 seconds, deadline]`. Exact reconstruction against entitled raw BRTI and final
settlements remains to be verified. The application always scores the official Kalshi result,
never its own reconstruction of the average.

When BRTI is missing, a common venue-to-index uncertainty remains in every proxy-dependent
reading. Its minimum log deviation of `0.0005` (approximately 0.05%) is an explicit engineering
assumption, not a fitted error estimate. Repeated or missing samples never count as independent
confirmations. Proxy probabilities are not claimed to be calibrated.

The Kalshi-only migration deletes old non-Kalshi archive records and browser upload queues.
Compatibility validation exists only to inspect retained storage safely during migration.

Fixed publication waits up to 180 seconds, or roughly a quarter of remaining time on a late
join, with a 15-second minimum. It publishes the first valid estimate through five minutes
after joining or five seconds before close, whichever is earlier. Weak signals remain eligible;
essential invalid data can still prevent a call. Live probabilities and fixed-call failure risk
continue changing while the original saved call remains immutable.

## Outcomes and learning

Closed forecasts await official settlement and do not block the next event. Results are fetched
again after reconnecting or restarting. Only a finalized result for the saved exact market can
resolve a call. Coinbase prints cannot substitute for it. Equality is scored according to
Kalshi's YES result. Saved v1 and v2 forecasts retain their original model identity, probabilities,
parameter assumptions and outcomes. New calls use v2. An unfinished observation created by an
unavailable older model cannot silently publish using different math.

Automatic browser/persistent research follows real contracts at 12, 9, 6, 3 and 1 minute remaining.
All checkpoints from a contract remain in the same chronological group. Missing checkpoints and
outcomes remain visible. Only Kalshi evidence can train or activate a model artifact.
See [the learning pipeline](forecast-learning.md) and [collector setup](research-collector.md).

Passing tests proves implementation behavior, not predictive accuracy. The next empirical step
is collecting prospective Kalshi decisions, benchmark readings and official results, then
evaluating calibration, accuracy, Brier score, reversals and call coverage on later events.
