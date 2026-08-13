# Domain glossary

## Diffowl

The working product name for the code-review system. The name is provisional until the public-launch naming decision is resolved.

## AI-accelerated product team

The primary V1 adopter: a GitHub-hosted team of roughly 3–30 developers whose AI-assisted change throughput exceeds its capacity for consistent peer review. Product engineers own review quality and tooling without dedicated code-quality platform staff.
_Avoid_: Solo developer, open-source maintainer, enterprise platform team, maintainer-led product team

## Review OWL

The user-facing review role that performs the missing first pass on every eligible pull request, verifies material findings, and directs scarce human attention. A clean result means no material findings were found; it is not proof that the change is correct.
_Avoid_: Autonomous approver, peer-review replacement, review bot

## Targeted human review

The V1 review workflow in which a person validates Review OWL findings, checks product and business alignment, and decides whether to merge. A person is not expected to reread all code after a completed clean review, but retains approval authority.
_Avoid_: Full duplicate review, autonomous merge

## Review readiness

A configurable recommendation that a pull request is ready for targeted human review or should first return to its author for changes. It directs workflow but does not approve or merge the pull request.
_Avoid_: Correctness guarantee, autonomous approval

## Finding discussion

An author-led conversation attached to a finding in which the pull-request author supplies missing product or technical context and Review OWL reassesses its claim. The author uses this loop to resolve, rebut, or accept findings until the pull request is ready for targeted human review; dispositions remain visible and auditable.
_Avoid_: Generic pull-request chat, silent dismissal

## Policy-qualified automated approval

An opt-in outcome for a completed clean review when deterministic CI passes, no configured high-risk exception applies, and project policy explicitly permits automation. It does not guarantee correctness or grant Review OWL merge authority.
_Avoid_: Default approval, autonomous merge, AI correctness guarantee

## Review engine

The forge-independent core that gathers review context, orchestrates RunCell agents, validates and normalizes findings, and computes review outcomes. It does not publish to GitHub directly.

## Self-hostable review path

The full V1 pull-request review workflow that a team can inspect, run, and control without a Diffowl-hosted service. It includes the review engine, GitHub Action adapter, local CLI, project policy, finding ledger, review outcomes, GitHub publishing, provider configuration, and security enforcement.
_Avoid_: Hosted-only core, commercial review engine, cloud-required review

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
