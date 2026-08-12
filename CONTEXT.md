# Domain glossary

## Diffowl

The working product name for the code-review system. The name is provisional until the public-launch naming decision is resolved.

## Review engine

The forge-independent core that gathers review context, orchestrates RunCell agents, validates and normalizes findings, and computes review outcomes. It does not publish to GitHub directly.

## GitHub Action adapter

The V1 delivery adapter that translates GitHub pull-request events and data into review-engine input, then publishes the engine's result through GitHub review surfaces.

## Finding

A structured claim that a pull-request change causes a material problem. A finding includes its location, impact, evidence, lifecycle state, and verification state.

## Verification

An attempt to strengthen or reject a candidate finding using repository evidence, deterministic analysis, or executable behavior. Verification is not synonymous with a second model agreeing.

## Review outcome

The typed result of a review run, distinguishing clean completion, findings, partial coverage, policy skips, limits, timeouts, provider failures, configuration failures, and internal failures.

## Finding ledger

Persistent per-pull-request state that identifies findings across pushes and records whether each finding is new, persisting, resolved, or obsolete.

## Trust class

A classification of the pull request and execution context that determines whether secrets, tools, code execution, and publishing are permitted.

## Project policy

Base-branch repository configuration that controls review scope, rules, verification, presentation, and budgets within non-overridable security ceilings.
