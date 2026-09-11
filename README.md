# Bitcoin tracker for Kalshi

An internal dashboard for Kalshi's **KXBTC15M Bitcoin events**, built with Next.js App Router, React, React Bootstrap, SCSS, Redux Toolkit, RTK Query, React Select, ECharts, and jStat. JavaScript/JSX throughout.

## Run locally

Use Node 24 and install dependencies with the project's package manager:

```sh
pnpm install
pnpm dev
```

Open [localhost:3000](http://localhost:3000). On Windows, if Turbopack cannot spawn its Sass worker, run `pnpm exec next dev --webpack`. The equivalent production verification is `pnpm exec next build --webpack`.

## What it does

- Loads the actual Kalshi target and 15-minute close time. YES means the rounded final-minute BRTI average is at or above the target; equality is YES.
- Defaults to the current contract. Select an upcoming event to schedule it, even while its target is pending. Keep the page open for the scheduled start.
- Counts down to the original close time. Joining with 12 minutes left starts at 12 minutes, without extending the event.
- Shows a live estimate and a separate immutable fixed call. Observation takes up to three minutes, with shorter waits for late joins. Valid weak and balanced estimates can publish without a confidence threshold.
- Shows the estimated chance that a fixed call loses, plus current buying/selling pressure and market conditions.
- Models the final-minute average, including already observed benchmark readings and uncertainty in missing readings.
- Uses the full hour of BRTI history for responsive index volatility and movement features when complete; Coinbase trades remain an optional pressure input. Healthy native BRTI estimates continue through Coinbase outages.
- Scores forecasts only against the official finalized Kalshi result, retrying after reconnecting or reloading.
- Records real contracts at 12/9/6/3/1 minutes remaining for chronological evaluation and guarded outcome learning.

Coinbase candles, executed trades and order-book data remain market inputs. Their source is explicitly labeled. The old Coinbase forecast mode, custom targets, custom scheduling controls, and legacy research recorder have been retired.

## Data access

Public Kalshi contracts, quotes, results and Coinbase inputs need no API key. The browser streams Coinbase trades and liquidity; server routes fetch market history and Kalshi data.

Official BRTI samples require server-only `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY`, plus Kalshi's benchmark entitlement. See [.env.example](.env.example) and [Kalshi setup and methodology](docs/kalshi.md). Without entitled access, probabilities use a clearly labeled Coinbase proxy and additional index uncertainty. The proxy cannot determine settlement.

Enter the production Key ID and the full downloaded private key in the ignored `.env.local` file. Run `pnpm kalshi:check` to verify fresh BRTI access, then restart the development server and any running collector. The check prints only the feed status and safe guidance; it does not write research records.

The benchmark API documentation does not publish an entitlement price. Confirm any access charge and distribution terms with Kalshi. Existing entitled access supplies the required hour of BRTI history, with no additional subscription needed by this implementation.

## Reliability and learning

The settlement model is experimental. Passing implementation tests is not evidence of predictive accuracy. The proxy uncertainty floor is an explicit engineering assumption, not a fitted error estimate.

Candidates train on earlier real Kalshi outcomes, calibrate and test on separate later events, and must pass prospective comparisons before activation. All checkpoints from one event are grouped so repeated observations cannot inflate the independent sample count. Benchmarks include the current-side rule and contemporaneous Kalshi quotes where available. Training never rewrites captured calls.

Baseline v2 and learned v2 record their price and history sources. BRTI results qualify BRTI models; older model generations and proxy history do not substitute for new prospective evidence. Existing v1 forecasts retain their original probabilities and outcomes.

See [outcome learning](docs/forecast-learning.md), [continuous collection](docs/research-collector.md), and [verification guidance](docs/TESTING.md).

## Storage and deployment

Local development defaults to SQLite at `data/bitcoin-research.db`. Hosted/serverless deployments can use `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN`. Configure `RESEARCH_API_USERNAME` and `RESEARCH_API_PASSWORD` plus HTTPS/access controls for access beyond localhost.

The Kalshi-only migration removes old non-Kalshi research, forecast snapshots, and model artifacts. Browser startup clears old journal records, schedules and pending uploads before sync resumes. Kalshi records are retained. An already-open old tab may request a reload to clear its previous in-memory state.

Deploy as a Next.js application with serverless route support. Continuous collection while the browser is closed requires a separate always-on process; a serverless request cannot own a permanent WebSocket.

```sh
pnpm test
pnpm format:check
pnpm build
pnpm research:collect --once
```

No deployment or trading execution is included.
