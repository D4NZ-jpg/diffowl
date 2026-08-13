# Diffowl V1 specification

## Status

Canonical V1 implementation specification. Delivery is tracked in GitHub issues #17–#31.

This spec consolidates the resolved Wayfinder map [Find the way to a competitive Diffowl V1 specification](https://github.com/D4NZ-jpg/diffowl/issues/1). Detail remains in the linked decision tickets.

## Product promise

Diffowl V1 helps small AI-accelerated product teams reduce human review drag by giving every eligible pull request an evidence-backed first-pass review that the team can inspect, run, and control.

Review OWL prepares a pull request for targeted human review. A clean result means no material findings were found within completed permitted coverage. It is not a correctness guarantee, a merge decision, or a replacement for human product judgment.

Primary adopter and success framing: [Choose the primary adopter and switching job](https://github.com/D4NZ-jpg/diffowl/issues/2), [Define the competitive V1 promise and measurable success](https://github.com/D4NZ-jpg/diffowl/issues/5).

## V1 scope

### Required capabilities

V1 must provide:

- an installable GitHub Action review workflow for eligible same-repo pull requests;
- a reusable review engine that owns review semantics, policy interpretation, orchestration, finding normalization, ledger transitions, and typed outcomes;
- a local CLI that runs the same engine path for reproduction, debugging, inspection, and local evaluation;
- GitHub-native publication through review threads, a check run, annotations where useful, and one maintained current summary;
- a finding discussion loop where authors can accept, rebut, resolve, suppress, or request reassessment of findings;
- a finding ledger that reconciles findings across pushes and reruns;
- base-branch project policy for review controls;
- trust-class enforcement for secrets, validation commands, tools, publishing, and abstention;
- BYOK provider/model configuration through role profiles;
- synthetic evaluation and security threat tests that produce a release report card.

Scope line: [Draw the V1 capability and exclusion line](https://github.com/D4NZ-jpg/diffowl/issues/7).

### Non-goals

V1 must not include:

- GitHub App or hosted service dependency;
- GitLab, Bitbucket, Azure DevOps, or other forge support;
- hosted dashboards, billing, organization administration, or enterprise sales surfaces;
- generated commits, automatic patch application, validated fixer loops, or broad coding-agent behavior;
- broad first-class ecosystem-specific validation beyond configured project commands;
- autonomous merge authority;
- default automated approval;
- a correctness guarantee for clean reviews.

Open-source boundary: [Set the open-source and open-core boundary](https://github.com/D4NZ-jpg/diffowl/issues/6).

## Architecture

### Modules and ownership

V1 has these main boundaries:

1. **Review engine**
   - Owns canonical domain types: project policy, trust-class result, review scope, budget envelope, orchestration plan, candidates, findings, verification state, finding ledger, run records, and review outcomes.
   - Does not publish directly to GitHub.

2. **RunCell orchestration layer**
   - Lives behind the review engine.
   - Uses RunCell for provider-backed agent execution, structured outputs, files, events, and snapshots.
   - Does not treat RunCell as a security boundary or product-level orchestration boundary.

3. **GitHub Action adapter**
   - Translates GitHub events and repository state into engine input.
   - Loads project policy from the trusted base branch.
   - Enforces Action-specific security gates.
   - Publishes normalized engine output to GitHub.

4. **Privileged publisher**
   - Separate SHA-bound, data-only publishing step where needed.
   - Validates schema, size, source run, exact head SHA, and target publication surfaces.
   - Never executes pull-request code or treats artifacts as executable instructions.

5. **Local CLI adapter**
   - Runs the same engine behavior locally.
   - Uses local input/output and optional dry-run or explicit publishing modes.
   - Labels output as local, not CI-trusted.

6. **Persistence implementations**
   - Implement engine-defined interfaces for finding ledgers, run records, artifacts, RunCell snapshots, and publication receipts.
   - Must support self-hosted Action and local CLI operation without a hosted database.

Architecture decision: [Choose delivery architecture and state ownership](https://github.com/D4NZ-jpg/diffowl/issues/8).

### State ownership

- **Project policy**: base-branch config interpreted by the engine within non-overridable ceilings.
- **Trust class**: classified before risky work and passed to the engine as a constraint.
- **Run state**: engine-owned versioned run record.
- **Finding state**: engine-owned finding ledger.
- **Verification state**: engine-owned evidence and verification metadata.
- **RunCell snapshots**: execution artifacts stored through persistence interfaces; not canonical review semantics.
- **GitHub publication state**: adapter-owned receipts for checks, reviews, comments, annotations, and summary locations.

## Trust classes and security

V1 must distinguish:

1. **Trusted same-repo PR**
   - Same repository branch.
   - Reviewed under base-branch project policy.
   - Eligible for configured validation commands within sandbox and timeout limits.

2. **Untrusted fork or Dependabot PR**
   - No secrets, write tokens, privileged tools, or sensitive code execution.
   - May receive limited static/diff review.
   - Must report partial coverage or abstention where verification is materially blocked.

3. **Privileged publisher**
   - Has GitHub authority to publish.
   - Treats review output as bounded data.
   - Never runs PR code.

4. **Local CLI**
   - User-authorized local execution.
   - May use local credentials according to explicit invocation.
   - Must not imply CI-grade trust.

5. **Over-budget, unsafe, or unsupported**
   - Produces explicit skip, partial, limit, or failure outcome.
   - Must not degrade into clean.

Security decision: [Define trust classes, sandboxing, and credential boundaries](https://github.com/D4NZ-jpg/diffowl/issues/9).

## Project policy

V1 project policy may configure:

- include/exclude paths;
- generated/vendor handling;
- review scope and risk rules;
- severity thresholds and advisory presentation;
- validation commands for trusted contexts;
- hard review timeout and protective ceilings;
- provider/model role profiles;
- GitHub presentation preferences;
- opt-in policy-qualified automated approval eligibility.

Policy rules:

- GitHub Action loads policy from the trusted base branch.
- Pull-request content cannot weaken its own review rules.
- Non-overridable security ceilings always win.
- Future organization defaults, repository policy, and local invocation overrides compose by strictness.
- Invalid or security-weakening policy fails closed with a typed configuration outcome.

Policy decision: [Define project configuration and policy precedence](https://github.com/D4NZ-jpg/diffowl/issues/12).

## Provider, model, and budget controls

V1 uses BYOK provider configuration:

- teams provide credentials through GitHub secrets, local environment, or future self-hosted secret stores;
- provider/model choices are configured through role profiles;
- no Diffowl-hosted provider is required.

Minimum role profiles:

- **reviewer**: generates candidate findings and advisory suggestions;
- **challenger**: attacks candidates for false positives, weak evidence, and low materiality;
- **verifier**: strengthens, weakens, or rejects candidates using permitted evidence.

Budget model:

- hard review timeout is the primary user-facing V1 budget;
- protective ceilings may cover output size and finding count;
- token/cost data is recorded when available but not promised as exact portable enforcement;
- provider failures, timeout, or budget-limit runs fail with typed outcomes and never appear clean.

Provider decision: [Define provider, model, and budget controls](https://github.com/D4NZ-jpg/diffowl/issues/14).

## Review semantics

### Publishable outputs

V1 distinguishes:

- **Material findings**: structured claims that a PR change causes a material problem. They include location, impact, evidence, lifecycle state, and verification state.
- **Advisory suggestions**: non-blocking improvement suggestions, visually and semantically separate from material findings.
- **Review outcome**: run-level typed result.

Material findings drive review readiness. Advisory suggestions do not make a review non-clean by themselves.

### Evidence and verification

Model consensus may support candidate generation, ranking, and challenge loops, but is not verification by itself.

A material finding should be backed by one or more of:

- repository evidence from diff, surrounding code, tests, docs, config, or call sites;
- deterministic analysis;
- executable behavior from allowed validation commands;
- contradiction with project policy or explicit review rules;
- explicitly labeled reasoning with clear verification limitations.

Candidates that lack enough evidence should be suppressed, downgraded to advisory, or reflected through partial coverage or abstention.

### Typed outcomes

The engine must expose rich typed outcomes, including:

- clean completed review;
- material findings present;
- partial coverage;
- policy skip;
- unsupported PR or change shape;
- budget or resource limit;
- timeout;
- provider failure;
- configuration failure;
- internal failure;
- abstention.

Review semantics decision: [Define review, verification, and abstention semantics](https://github.com/D4NZ-jpg/diffowl/issues/10).

## Finding ledger

V1 must keep an engine-owned finding ledger.

### Identity

Findings are identified by stable engine-generated fingerprints derived from:

- claim kind;
- normalized material problem summary;
- affected file, symbol, API, config key, or behavior area;
- normalized evidence anchors;
- relevant policy rule or reviewer capability;
- enough location context to distinguish nearby problems.

Line numbers and GitHub thread ids are matching hints and publication handles, not identity.

### Lifecycle states

V1 tracks:

- new;
- persisting;
- resolved;
- obsolete;
- rebutted;
- accepted;
- suppressed.

### Versioned runs

Each run record includes at least PR/head SHA, base or merge-base context, trust class, policy hash, engine version, safe provider/model metadata, budget envelope, validation attempts, and final typed outcome.

Ledger decision: [Define incremental finding-ledger semantics](https://github.com/D4NZ-jpg/diffowl/issues/11).

## GitHub review UX

V1 uses:

- **review threads** as the primary human interaction surface for material findings and useful inline advisory suggestions;
- **check run** as machine-readable status;
- **one maintained PR summary** as the compact current state;
- **annotations** as optional supporting visibility;
- **local CLI output** as a local mirror of engine output.

Material finding threads should include problem, impact, evidence, verification state, lifecycle state, recommended next action, and reconciliation metadata.

Minimal audited commands:

- rerun/recheck;
- explain;
- ignore/suppress according to policy;
- mark resolved/recheck;
- request reassessment with author context.

Freshness rules:

- old clean results must not look current after a new push/rerun/policy change;
- stale output should be superseded, minimized, collapsed, or de-emphasized where GitHub permits;
- one current summary remains authoritative for humans;
- publication receipts remain adapter state.

UX decision: [Design GitHub review UX and operator commands](https://github.com/D4NZ-jpg/diffowl/issues/13).

## End-to-end V1 workflow

1. Team installs the GitHub Action and configures provider credentials.
2. Team commits base-branch project policy.
3. Same-repo pull request opens or updates.
4. Action classifies trust and loads base-branch policy.
5. Action gathers PR context and invokes the review engine.
6. Engine builds review scope and budget envelope.
7. Engine orchestrates RunCell-backed reviewer, challenger, and verifier roles.
8. Engine verifies or suppresses candidate findings.
9. Engine reconciles findings through the ledger.
10. Adapter publishes review threads, check run, annotations where useful, and maintained summary.
11. Author discusses, accepts, rebuts, suppresses, or resolves findings.
12. Diffowl reassesses as needed.
13. Review OWL reports a typed review-readiness outcome.
14. Human performs targeted human review and decides whether to merge.

## Acceptance criteria for `/to-tickets`

A ticket breakdown should cover enough work to prove this scenario:

- install the Action in a representative repository;
- run the local CLI against the same review engine path;
- review a trusted same-repo pull request;
- load policy only from the base branch;
- classify trust and deny unsafe operations for fork/Dependabot cases;
- run an allowed validation command in a trusted context;
- produce a material finding with evidence and verification state;
- publish the finding inline as a review thread;
- publish a current check and maintained summary;
- discuss/reassess at least one finding;
- preserve finding lifecycle across a push;
- handle timeout/provider failure as non-clean typed outcomes;
- run the synthetic evaluation corpus;
- run required threat tests;
- produce a release report card.

## Release evidence

Before public V1 release, Diffowl should produce a report card from a repeatable synthetic corpus and threat-test suite.

Report card includes:

- expected material findings found/missed;
- unexpected findings on clean controls;
- advisory suggestions emitted;
- skip/partial/limit/timeout/provider/config/internal outcomes;
- duplicate or stale visible GitHub output;
- review-ready latency;
- available token/cost/runtime diagnostics.

Threat tests cover fork/Dependabot restrictions, secret non-exposure, base-branch policy loading, non-overridable ceilings, privileged publisher validation, head-SHA binding, stale-head prevention, timeout/failure non-clean behavior, unsafe validation denial, and data-only publication.

Evaluation decision: [Define evaluation and release gates](https://github.com/D4NZ-jpg/diffowl/issues/15).

## Risks and follow-up questions

- Synthetic evaluation may miss real pull-request messiness; dogfood evidence is advisory but should be captured when available.
- Exact token/cost enforcement may vary by provider and RunCell surface.
- GitHub may not support true collapse/minimize behavior for every output surface; adapter must use the least noisy native option.
- Public product name remains unresolved; Diffowl is provisional.
- Policy-qualified automated approval needs stricter separate evidence before it becomes a recommended path.

## Post-V1 / future scope

- GitHub App and hosted service.
- Hosted dashboards, team analytics, managed storage, provider management, and organization policy rollout.
- Multi-forge support.
- Generated commits, patch application, fixer loops, and broad coding-agent behavior.
- Hard numeric release thresholds based on real adopter data.
