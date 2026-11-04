# Agent entry guide

## Project overview

BitcoinTracker is a Next.js App Router application for Kalshi Bitcoin forecasts, research, and
simulated trading. It uses React, JavaScript/JSX, React Bootstrap, SCSS, Redux Toolkit, and RTK Query.
Use pnpm; `package.json` defines the current dependencies and commands.

Jest and Testing Library verify behavior. Prettier owns formatting.

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
- Search existing code for reusable behavior. Choose its owner using the architecture standard.
- Keep UI semantic and keyboard accessible, meeting WCAG 2.2 AA. Preserve server/client boundaries
  and never expose credentials or sensitive data in source, logs, or reports.
- Protect saved forecasts, research evidence, and account history. Use isolated test storage;
  routine verification must not mutate the working research database or start paid experiments.
- Clarify ambiguous requirements before risky or broad changes. Explain material concerns and
  recommend a better approach before implementing a problematic proposal.

## Documentation routing

This file is the entry point. Keep detailed standards and domain documentation under `docs/`, with
one owning document per standard. Link to rules instead of duplicating them here or across documents.

Read the standard that matches the task alongside the affected implementation and tests. For topics
without a standard yet, inspect the relevant code and configuration.

| Work                                                                                       | Standard                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| Adding or moving files, defining feature boundaries, or deciding where shared code belongs | [Architecture and code ownership](docs/architecture.md) (in review) |
| Adding or changing API endpoints, uncached requests, or API helpers                        | [APIs and services](docs/services.md) (in review)                   |
| Writing, organizing, or reviewing automated tests                                          | [Automated feature tests](docs/automated-testing.md) (in review)    |

For setup commands, consult the root README and `package.json` as needed. Write standards for the
intended refactor using illustrative examples such as Weather. Use the current implementation to
verify claims about existing behavior and to trace consumers during a migration.

## Handling conflicts

- Documentation defines intended standards and contracts; code and tests show current behavior.
  When they disagree, report the discrepancy and determine whether it is stale guidance, a defect,
  or an intentional exception. Do not silently treat either as permission for a broader rewrite.
- Use current configuration to verify tooling and commands. Treat dated investigations, verification
  reports, and archived policy sections as historical evidence, not automatically as current rules.
- If a conflict leaves the requested behavior or safe scope unclear, ask before the affected change.
  Continue independent work that is already authorized.
- When an authorized change alters a documented contract, update its owning document within scope.
  Keep documentation routes current when documentation is added or moved. Do not reorganize unrelated
  documentation as part of a code change.

## Completion requirements

- Check the final diff against the request and preserve unrelated work.
- Run the owning tests after behavior changes, then
  `pnpm test`, `pnpm format:check`, and `pnpm build`. Verify UI changes at desktop and mobile sizes.
  Report targeted tests, full regression, formatting, build, and applicable browser/data checks
  separately; identify anything not run and why. Passing tests does not establish forecast accuracy
  or trading profitability.
- For documentation-only changes, verify claims, linked files and headings, and formatting. Runtime
  tests, builds, and browser checks are unnecessary unless executable behavior also changes.
- Summarize what changed, why, verification results, and unresolved issues. Respect requested review
  checkpoints before proceeding to another phase.
