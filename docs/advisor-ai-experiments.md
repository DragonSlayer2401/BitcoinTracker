# History-aware paper adviser experiments

This experiment compares three separate paper accounts: the unchanged numerical adviser, a
history-based rules candidate, and an optional language-model candidate. Each starts with the same
configured trading allocation and risk policy. The user's existing paper account, forecast
models, saved evidence and original strategy trials remain separate. No real order endpoint,
credentials change, automatic strategy rewrite or promotion is introduced.

## What the AI decides

`advisorCandidate.utils.js` constructs the available choices using the existing forecast,
executable order book, fees, slippage, position inventory and account limits. The model selects
BUY YES, BUY NO, HOLD, REDUCE, EXIT or NO TRADE from that supplied list. It may disagree with the
incumbent. It cannot supply probabilities, prices, quantities, confidence percentages or risk
settings. The chosen action's current amounts are recomputed before acceptance.

The evidence contains up to twelve observations from the preceding three minutes of the exact
same contract, including its target and deadline. It provides probability changes, executable
purchase/sale values, remaining time, reference price and distance from target, available
volatility, depth, costs, account state, position age, entry probability/rationale, previous
recommendations and the prior trade thesis. Missing numerical inputs remain missing. The LLM
never receives the full research archive, a future official result or arbitrary database access.

Each structured output must identify its snapshot and option, cite real evidence IDs, and state
a plain-language rationale, thesis, invalidation conditions and review horizon. All supplied
text is explicitly treated as untrusted data. The model receives no tools. Responses with
unrecognized fields, fabricated references, numeric trading instructions in narrative fields,
wrong contract/account identity, stale inputs or a superseded snapshot are vetoed.

Candidate exits are separately versioned because the incumbent's execution check requires a
sale to beat an optimistic holding value. A candidate may reduce or exit a deteriorating thesis
without satisfying that same opinion about holding. It still needs verified fresh data, owned
unreserved inventory, code-calculated limit prices and minimum net proceeds, available depth,
the original fill delay/window, fees and realistic partial IOC fills. The incumbent repository's
exact numerical replay check and incumbent simulation remain unchanged.

## The simpler comparison

The rules candidate requires entry value to persist across three observations spanning at least
thirty seconds. Holding has no blind minimum duration. Exits can follow a sharp probability
drop, sustained deterioration, persistently better sale value or approaching expiry; moderate
deterioration may reduce exposure. These thresholds are experimental versioned assumptions,
not established profitable rules. Losing money or wanting to recover the entry price is never
an entry/holding signal. Existing entry cooldowns and risk limits remain authoritative.

## Plan and execution readiness

`advisorPlan.utils.js` and `advisor_current_plans` preserve a current plan independently of
routine operational messages. Financial state, contract identity and original evidence expiry
must still match. Routine writes do not extend the original validity time. A HOLD can remain
HOLD during a cooldown; a recorded conditional entry shows its actual price condition.

Execution status separately reports readiness, missing fresh quotes, observation, pending orders,
cooldowns, fills, cancellations, staleness and closure. Filled entry intentions are consumed.
Until the normal next assessment, the display identifies the fill and reassessment instead of
repeating BUY. When evidence expires, the former plan is explicitly historical and the current
assessment is unavailable. A real absence of opportunity remains NO TRADE. Entry thresholds,
cooldown durations and the incumbent decision cadence were not relaxed to change the labels.

## Enable the paid candidate deliberately

The history-rules comparison starts with the existing `--trading-advisor` collector after its
restart. A newly registered trial only enrolls contracts that begin after registration; it does
not backfill old events. The language-model account remains disabled and is labeled Not evaluated
unless these server-only values are added to `.env.local`:

```dotenv
OPENAI_API_KEY=your-key
ADVISOR_LLM_ENABLED=true
ADVISOR_LLM_MODEL=gpt-6.1-sol
```

Keep the existing Kalshi credentials unchanged. Restart the app and collector after configuration:

```sh
pnpm research:collect --trading-advisor
```

The default inference limits are one request at a time, at least sixty seconds between requests,
ten seconds per request, a 32 KiB complete request, 1,200 maximum output tokens and $1 per UTC day.
The optional `ADVISOR_LLM_*` fields in `.env.example` document the bounded overrides. These spend
controls apply only to the paid AI API. They do not restore the removed trading daily-loss cutoff.
No key was configured and no paid inference was run during implementation.

The official identifier is `gpt-6.1-sol`. The Responses API and structured outputs are supported;
the adapter uses low reasoning effort and standard service pricing, no tools and `store: false`.
As verified on October 3, 2026, standard prices are $2 per million input tokens and $10 per million
output tokens. A 4,000-input/1,000-output-token response would cost approximately $0.018, including
reasoning tokens in the output usage. Actual requests vary. See the
[official model specification](https://developers.openai.com/api/docs/models/gpt-6.1-sol) and
[structured-output guide](https://developers.openai.com/api/docs/guides/structured-outputs).

The documentation currently lists this model identifier without a dated snapshot. The trial
freezes the requested identifier, returned identity, prompt/schema hash, policy and configured
limits. A changed returned model identity is rejected. An unchanged alias cannot prove unchanged
underlying weights; that remains a limit of the available API metadata, not a claimed guarantee.

## Timing, costs and failures

Inference starts outside the incumbent writer lease and is not awaited by its trading loop.
The server adapter's `invoke` interface can be replaced by a mocked provider for tests. Responses
and their arrival times are saved as proposals. Only a later current observation may accept one;
prices, account version, risk and expiry are checked again at that time. Orders then wait for a
subsequent qualifying execution observation. Decisions and fills are never backdated to make a
late answer look timely.

The declared fallback is the incumbent evaluated for the AI account using current evidence.
Timeouts, refusals, failed requests, expired responses and vetoes are recorded separately from
that fallback. A restart does not resend an already reserved paid request. Budget reservations
are durable across processes; unknown-cost requests retain their maximum conservative charge
even when their concurrency reservation expires. Verified usage reconciles the charge.

API charges are tracked as evaluation expenses separately from the common simulated trading
allocation. Net profit subtracts those charges, and net drawdown includes them. Trading fees,
turnover, reversals, quantity-weighted holding duration, fills, failed exit attempts and inference
failures are reported. A missed exit means a recommended sale that did not fill in the available
observation window; it is not hindsight detection of every profitable exit opportunity.

The three accounts share the collector's existing book observations and official results.
When only shadow orders need an execution observation, they share one additional read through
the existing durable Kalshi rate limiter. Each intention can claim that read only once, including
across restarts. No Kalshi order request is sent. A lost or failed claimed observation cannot be
replaced by a later favorable book: it cancels or expires with no fill and releases reserved cash.
This sampling limitation, queue position, price movement between observations,
and the model's real response latency still need prospective evaluation. A simulated fill is not
proof that a live order would have filled.

## What counts as evidence

`advisor_history_trials` freezes a new manifest and cohort. `advisor_history_observations` keeps
immutable observation/response evidence and proposed, accepted, vetoed and fallback decisions.
`advisor_history_state` materializes independent accounts and bounded history.
`advisor_history_execution_requests` preserves the single shared observation claims. Separate
`advisor_ai_reservations` and immutable `advisor_ai_completions` audit spending. Existing numerical
models and original `advisor_profit_*` trials are unchanged.

The first 120 future contracts form a fixed sample. Missing official outcomes remain missing;
later convenient contracts cannot replace them. Results include zero-trade contracts. Review
requires a complete sample, at least a day of observation, sufficient traded contracts, positive
net profit, a positive conservative paired-profit bound and acceptable relative drawdown.
Recording gaps or unreconciled inference charges prevent a clean readiness claim.

There is no automatic promotion path for these candidates. Even passing the review conditions
only makes a candidate eligible for explicit human review. The initial saved hypotheses test
whether pullbacks should be tolerated, when deterioration warrants exit, and whether an LLM
adds value beyond the simple rules. They do not rewrite themselves from a model explanation.

What remains to establish: measured request latency and account access with a configured key;
independent prospective results after trading and inference costs; adequate fill/exit coverage;
whether reduced turnover improves profit rather than delays losses; and whether the result
persists in a further untouched confirmation period. No profit advantage is claimed yet.
