# History-aware paper adviser experiments

This experiment compares three separate paper accounts: a numerical adviser comparison, a
history-based rules candidate, and an optional language-model candidate. Each starts with the same
configured trading allocation and risk policy. The user's existing paper account, forecast
models, saved evidence and original strategy trials remain separate. No real order endpoint,
credentials change, automatic strategy rewrite or promotion is introduced.

New research policy versions limit every entry to one contract. The existing trial infrastructure
registers separately funded accounts and a fresh prospective cohort under the frozen research
policy; it does not refill an earlier account. Restarting reuses that registered experiment and
its current balances. Prior policies, losses, fees and inference charges remain in their original
experiments, each accessible separately in Performance. Initial paper funding and the entry cap
are displayed with each experiment. Inference costs remain separate evaluation expenses.

The original adviser's $85 floor remains enforced. Its $85.079 cash and $14.921 cumulative loss
at the October 4 inspection leave only $0.079 of loss capacity; independent experiment funding
does not increase that capacity or erase those losses. New research results cannot promote a
policy into the original account. Existing pending trial orders and settlement comparisons must
finish before the collector switches to the new prospective research version.

When AI is configured, the dashboard defaults to the **AI-assisted** account. Its recommendation,
cash, positions, risk and performance all come from that same independent paper account. The
**Numerical baseline** button shows the original account without rewriting its trades or losses.
This display choice is not evidence that the AI has passed profitability validation. Accepted
AI decisions already drive simulated orders in their own account; they are not commentary-only.
The main panel identifies AI-assisted plans, local numerical decisions and numerical fallbacks.
While a response is pending, the last completed plan stays visible with its original time and a
compact Updating label. AI-generated commentary and unaccepted proposal text are not displayed.

## What the AI decides

`advisorCandidate.utils.js` constructs the available choices using the existing forecast,
executable order book, fees, slippage, position inventory and account limits. The model selects
BUY YES, BUY NO, HOLD, REDUCE, EXIT or NO TRADE from that supplied list. It may disagree with the
incumbent. It cannot supply probabilities, prices, quantities, confidence percentages or risk
settings. The chosen action's current amounts are recomputed before acceptance.

The evidence contains up to twelve observations from the preceding three minutes of the exact
same contract, including its target and deadline. It provides probability changes, executable
purchase/sale values, remaining time, reference price and distance from target, available
volatility, depth, costs, account state, position age, entry probability and previous actions.
The paid request omits historical narrative and duplicate option metadata, retaining numerical
decision evidence. Missing numerical inputs remain missing. The LLM never receives the full
research archive, a future official result or arbitrary database access.

The `paper-advisor-choice-v2` structured output contains only action, option ID, snapshot ID,
evidence references and review horizon. The AI supplies a decision, not display prose. The
adapter validates those fields and supplies deterministic application text for the existing
internal audit format. The dashboard's labels, explanations and numerical order instructions
come from application code. All supplied text is explicitly treated as untrusted data. The
model receives no tools. Unrecognized fields, fabricated references, unavailable action/option
pairs, wrong contract/account identity, stale inputs and superseded snapshots are vetoed.

If a flat account has exactly one supplied choice, NO TRADE, the collector records the local
numerical plan without calling the provider or reserving API spend. It continues evaluating each
new market observation and resumes paid selection when another choice becomes available. A
local no-trade result does not consume the request interval or discard an in-flight response.
Restrictions identify insufficient loss capacity, insufficient edge, missing depth or expired
execution separately, instead of combining unrelated causes into an edge/depth message.
HOLD/REDUCE/EXIT alternatives continue to use the AI. The output-token ceiling is retained for
reasoning and complete JSON; shortening the output is not a claim of measured token savings.

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

`advisorPlan.utils.js` and `advisor_current_plans` preserve the last meaningful same-event plan
independently of routine operational messages. The current plan survives quote expiry, pending AI
reviews and failed refreshes, with its original Last reviewed time. Routine WAIT/HOLD writes can
increment account versions without changing money or inventory; that bookkeeping alone does not
revoke the human-facing plan. A quiet update message reports interrupted updates or price checks.

The plan and permission to execute an order have different lifetimes. The `active` display plan
continues until replaced or a real lifecycle change occurs. The `current` advice and executable
figures still require fresh evidence, matching account and policy, and applicable inventory.
Routine writes never extend `validUntil` or update the original assessment's account version.
Recovered plans can restore same-event guidance but cannot authorize old orders. Legacy saved
expiry boilerplate is normalized only in the display; archived records remain unchanged.

A fill shows PURCHASED, REDUCED or SOLD instead of repeating the previous instruction. A no-fill
shows ORDER NOT FILLED. Event closure, a changed target/deadline, changed policy, or removed,
reduced or opposite-side inventory starts a new review rather than carrying the old instruction
forward. A real absence of opportunity replaces the plan with NO TRADE. Plan conditions stay
available; current execution figures require fresh order evidence.
Pending-order and cooldown details are separate from the main plan. Entry thresholds, execution
expiry, risk controls, cooldowns, decision cadence and prediction math are unchanged.

### Advance sell instructions

An active BUY or HOLD includes a standing sell-limit instruction immediately below the main
plan. A BUY target applies after the entry fills; a HOLD target applies to its stated held side
and available quantity. The target survives the quote's 15-second expiry with the plan's original
review time. It ends when the plan is replaced, the order completes, inventory changes or the
event closes. It does not renew execution permissions or submit a resting order. Reserved
contracts must not receive a duplicate sale instruction.

The numerical target is the lowest whole-cent sale price where estimated net proceeds cover the
held-side forecast value plus the existing uncertainty reserve and exit advantage. Estimated
profit subtracts the corresponding entry cost including entry fees. A target can represent an
exit at a loss, so the UI does not call every sale a take-profit. If no price below the contract's
payout qualifies, the panel explains that no suitable limit was selected. AI HOLD uses a target
calculated for the available held quantity rather than inheriting a numerical partial-sale target.
When the AI chooses HOLD against a numerical SELL, its advance target also sits strictly above
the current best bid. This avoids suggesting a limit that would immediately sell the position
the AI just chose to hold. Proceeds and fees use that final price; if no higher valid whole-cent
price exists, the panel reports that no resting target is available.

Short holding periods and scalping are permitted by the existing AI EXIT/REDUCE choices; those
choices can take a fee-adjusted profit before settlement even when the numerical baseline keeps
holding. They remain subject to available depth, delay, price checks and position accounting.
The sell-limit display itself does not change risk policy or execution. The separate compact AI
prompt has its own version/hash and therefore a new prospective experiment; prior experiment
records remain intact. New-account results must not be treated as erased losses or improved P&L.
No improvement in trading profit is claimed from either change.

Loss exits remain model-driven per the user's preference. The model can recommend REDUCE/EXIT
when its thesis weakens, including selling at a loss; it has no arbitrary fixed cent-based stop.
Application conditions explain when to reconsider the position. A low sell limit is not a
stop trigger: it can execute immediately when a buyer already meets that price. Kalshi documents
prediction-market [limit sales](https://help.kalshi.com/en/articles/13823815-limit-order-sale) and
[auto-sell profit targets](https://help.kalshi.com/en/articles/15521632-auto-sell-take-profit).
This application neither submits a native stop order nor simulates a continuously resting stop.

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
Unit tests use mocked providers. Live activation requires a working key, an active collector,
usable market evidence and an API account permitted to run inference. Listing the model
successfully does not establish that assessment requests will be accepted. Authentication,
access, quota, rate-limit and request-format failures are shown separately without exposing raw
provider messages or credentials. Unavailable evidence does not consume an inference request.
Quota, authentication, access and rejected-request failures pause further provider calls for
that collector run. Fix the API account/configuration and restart collection to try again;
market recording and the labeled numerical fallback continue in the meantime.

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
