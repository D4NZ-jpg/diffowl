# Glossary

## Diffowl

The working product name for the code-review system. The name is provisional until the public-launch naming decision is resolved.

## AI-accelerated product team

The primary V1 adopter: a GitHub-hosted team of roughly 3–30 developers whose AI-assisted change throughput exceeds its capacity for consistent peer review. Product engineers own review quality and tooling without dedicated code-quality platform staff.
_Avoid_: Solo developer, open-source maintainer, enterprise platform team, maintainer-led product team

## Review OWL

The user-facing review role that performs the missing first pass on every eligible pull request, verifies material findings, and directs scarce human attention. A clean result means no material findings were found; it is not proof that the change is correct.
_Avoid_: Autonomous approver, peer-review replacement, review bot

## Review request

A request from a trusted same-repository pull-request author or a repository collaborator with write, maintain, or admin authority for Review OWL to inspect the latest verified pull-request revision. On GitHub, `/diffowl review` is the canonical request; a command router verifies the actor and latest head before dispatching review work at that revision. An eyes reaction acknowledges acceptance and the workflow check shows progress. Duplicate requests for active work are coalesced, completed revisions may be reviewed again within Project policy, and newer revisions supersede stale work. A Review request never grants trust or bypasses security ceilings, cooldowns, concurrency, or budgets.
_Avoid_: Rerun command, review of the comment-event revision, authorization override

## Targeted human review

The V1 review workflow in which a person validates Review OWL findings, checks product and business alignment, and decides whether to merge. A person is not expected to reread all code after a completed clean review, but retains approval authority.
_Avoid_: Full duplicate review, autonomous merge

## Review readiness

A configurable recommendation that a pull request is ready for targeted human review or should first return to its author for changes. It directs workflow but does not approve or merge the pull request.
_Avoid_: Correctness guarantee, autonomous approval

## Finding discussion

An author-led conversation attached to a Finding in which the pull-request author supplies missing product or technical context and Review OWL reassesses its claim. Finding commands start bounded reassessment of that Finding when the reviewed revision remains current; a newer revision requires a full review. One discussion continues across revisions while the same Finding persists; moved code may create a linked replacement thread without erasing the original conversation. Persisting and accepted Findings remain open, while resolved, rebutted, and suppressed Findings receive a visible disposition and close. An unanchored Finding uses its stable short identity in an author-authored pull-request command. The GitHub Action requires durable Finding state so dispositions remain visible and auditable until the pull request is ready for targeted human review.
_Avoid_: Generic pull-request chat, duplicate persisting thread, silent dismissal

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

## GitHub publication

The user-visible delivery of a Review outcome through GitHub's native review surfaces. The workflow check is the single merge-gating surface and reflects Review readiness under Project policy. The job summary gives a compact run account, and one non-approving pull-request review carries actionable Findings and Suggested patches. Publication is complete only when the required surfaces agree on the reviewed revision and Review outcome. The workflow check and job summary are always required for an eligible GitHub Action run; a pull-request review is required only when actionable Findings exist. Partial publication is a failure.
_Avoid_: Best-effort publication, silent partial success, progress comment, summary comment

## Publication result

The result of attempting GitHub publication, recording whether users received the Review outcome coherently. It is **complete** when every required surface agrees, **not attempted** when publication was not authorized or configured, **refused** when safety or freshness checks prevent visible effects, and **incomplete** when publication begins but completion cannot be proved. After an incomplete result, Diffowl records confirmed effects and reconciles them on the next authorized run; it does not delete Finding discussions or assume that GitHub effects can be rolled back. The workflow check and job summary make the failure visible without adding an emergency pull-request comment. A Publication result is distinct from the Review outcome and must not replace or rewrite it.
_Avoid_: Review outcome, publication receipt, generic publication failure, assumed rollback

## Finding

A structured claim that a pull-request change causes a material problem. A finding includes its location, impact, evidence, lifecycle state, and verification state.

## Suggested patch

A small, exact replacement attached to an active Finding on changed lines of the reviewed revision. It changes one contiguous region of an existing text file, stays within the Finding's changed-line range, and never changes more than 20 lines. It cannot create, delete, rename, or change the mode of a file, and it cannot modify workflows, permissions, credentials, dependency manifests, lockfiles, generated content, vendored content, binaries, symlinks, or submodules. Review OWL offers one only after applying it in permitted isolation and passing the narrowest relevant deterministic validation selected by Project policy within non-overridable security ceilings; the model cannot choose its own proof. Without permitted validation, the Finding remains actionable without a Suggested patch. The pull-request author chooses whether to apply it; Review OWL never writes the branch. A newer revision invalidates the suggestion.
_Avoid_: Autofix, unverified rewrite, multi-file patch, model-selected validation, general remediation advice

## Verification

An attempt to strengthen or reject a candidate finding using repository evidence, deterministic analysis, or executable behavior. Verification is not synonymous with a second model agreeing.

## Review outcome

The typed result of a review run, distinguishing clean completion, findings, partial coverage, policy skips, limits, timeouts, provider failures, configuration failures, and internal failures.

## Finding ledger

The durable per-pull-request record that identifies Findings across revisions and records their lifecycle transitions, processed command events, and confirmed publication effects. An eligible GitHub Action requires a trustworthy Finding ledger; missing, corrupt, or conflicting state cannot be replaced by comments or checks.

## Trust class

A classification of the pull request and execution context that determines whether secrets, tools, code execution, and publishing are permitted.

## Project policy

Base-branch repository configuration that controls review scope, rules, verification, presentation, and budgets within non-overridable security ceilings.
