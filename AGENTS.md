# Agent entry guide

## Project overview

BitcoinTracker is a Next.js App Router application for Kalshi Bitcoin forecasts, research, and
simulated trading. It uses React, JavaScript/JSX, React Bootstrap, SCSS, Redux Toolkit, and RTK Query.
Use pnpm; `package.json` defines the current dependencies and commands.

Routes live in `src/app/`, product code in `src/features/BitcoinTracker/`, services in
`src/services/`, and collector entry points in `scripts/`. Jest and Testing Library verify behavior;
Prettier owns formatting.

## General rules

- Follow direct user instructions over repository guidance. These rules apply throughout the repo;
  check for more specific `AGENTS.md` instructions in directories you work on.
- Edit files only when the user requests implementation or file changes. Investigation, review,
  brainstorming, and planning are read-only unless the user also authorizes edits.
- Inspect the working tree before editing. Preserve unrelated local changes; do not revert,
  overwrite, or reformat them. Do not commit, push, open PRs, or change Git history unless requested.
  Do not run destructive commands unless the user explicitly requests them.
- Read the relevant code and documentation before choosing an approach. Keep changes within the
  requested scope and preserve behavior and structure unless the task requires changing them.
- Search existing shared and feature-local code before creating abstractions. Reuse established
  patterns and put changes in the narrowest owning feature or service.
- Keep UI semantic and keyboard accessible, meeting WCAG 2.2 AA. Preserve server/client boundaries
  and never expose credentials or sensitive data in source, logs, or reports.
- Protect saved forecasts, research evidence, and account history. Use isolated test storage;
  routine verification must not mutate the working research database or start paid experiments.
- Clarify ambiguous requirements before risky or broad changes. Explain material concerns and
  recommend a better approach before implementing a problematic proposal.

## Documentation routing

This file is the entry point. Keep detailed standards and domain documentation under `docs/`, with
one owning document per standard. Link to rules instead of duplicating them here or across documents.

Read only the documents and sections relevant to the task, using the table below. Do not load the
entire documentation folder upfront. If the task crosses another responsibility, read its guidance
before changing that area. Read the affected implementation and tests alongside the documentation.

| Work                                                                             | Read                                                                                                                   |
| -------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Finding ownership; changing routes, features, hooks, state, services, or storage | [Architecture](docs/architecture.md)                                                                                   |
| Planning verification, changing behavior, or reviewing test coverage             | [Testing](docs/TESTING.md)                                                                                             |
| Changing charts or market-data presentation                                      | [Chart behavior](docs/architecture.md#read-the-coinbase-chart) and relevant UI checks in [Testing](docs/TESTING.md)    |
| Changing Kalshi contracts, benchmark access, deadlines, or settlement            | [Kalshi integration](docs/kalshi.md)                                                                                   |
| Changing forecasts, learning, evaluation, or model activation                    | [Forecast learning](docs/forecast-learning.md)                                                                         |
| Changing collection, replay, or background processing                            | [Research collector](docs/research-collector.md)                                                                       |
| Changing adviser setup, account status, or numerical adviser behavior            | [Trading adviser](docs/trading-advisor.md)                                                                             |
| Changing standalone paper trading or shared simulated execution/accounting       | [Paper trading](docs/paper-trading.md); also [Trading adviser](docs/trading-advisor.md) when both engines are affected |
| Changing history-based rules or language-model paper experiments                 | [AI adviser experiments](docs/advisor-ai-experiments.md)                                                               |
| Changing chart-pattern detection, training, or comparisons                       | [Chart-pattern research](docs/chart-patterns.md)                                                                       |
| Changing futures feeds or their forecast inputs                                  | [Derivatives](docs/derivatives.md)                                                                                     |
| Changing hypothetical purchase costs or order-book comparisons                   | [Purchase value](docs/kalshi-purchase-value.md)                                                                        |

The table routes to existing documentation. Dedicated standards will be added incrementally after
review; do not assume an unlisted standards file exists. For setup commands, consult the root README
and `package.json` as needed. When editing documentation, read its owning document and verify its
claims against the relevant code and configuration.

## Handling conflicts

- Documentation defines intended standards and contracts; code and tests show current behavior.
  When they disagree, report the discrepancy and determine whether it is stale guidance, a defect,
  or an intentional exception. Do not silently treat either as permission for a broader rewrite.
- Use current configuration to verify tooling and commands. Treat dated investigations, verification
  reports, and archived policy sections as historical evidence, not automatically as current rules.
- If a conflict leaves the requested behavior or safe scope unclear, ask before the affected change.
  Continue independent work that is already authorized.
- When an authorized change alters a documented contract, update its owning document within scope.
  Keep this routing table current when documentation is added or moved. Do not reorganize unrelated
  documentation as part of a code change.

## Completion requirements

- Check the final diff against the request and preserve unrelated work.
- For code changes, follow the relevant verification requirements in [Testing](docs/TESTING.md).
  Report targeted tests, full regression, formatting, build, and applicable browser/data checks
  separately; identify anything not run and why. Passing tests does not establish forecast accuracy
  or trading profitability.
- For documentation-only changes, verify claims, linked files and headings, and formatting. Runtime
  tests, builds, and browser checks are unnecessary unless executable behavior also changes.
- Summarize what changed, why, verification results, and unresolved issues. Respect requested review
  checkpoints before proceeding to another phase.
