---
title: Trust model
description: How Diffowl classifies pull requests and constrains secrets, tools, validation, state, and publication.
---

Diffowl classifies trust before it reads pull-request-controlled repository content or starts provider-backed work. Trust is a product-level constraint; RunCell is not treated as a security boundary.

## Trust classes

### Trusted same-repository pull request

A branch in the base repository is reviewed under policy loaded from the base commit. It may use configured provider credentials, validation commands, durable state, and GitHub publication when required permissions are available.

### Trusted collaborator fork (opt-in)

Teams that work from personal forks of a private repository can set `trust.collaboratorForks: true` in the base-branch policy. A fork pull request is then reviewed with the same capabilities as a same-repository pull request when its author holds `write`, `maintain`, or `admin` permission on the base repository. The permission is read from the GitHub collaborators API at review time; the fork's location and the pull-request event are not trusted on their own.

Three independent checks apply, in order: the `/diffowl review` router reads the base-branch policy and the author's permission before dispatching; the dispatched run re-reads the live pull request and refuses if the head repository does not match the dispatch; and trust classification runs the same policy and permission lookup again before any provider credential is resolved. A failed or unavailable permission lookup fails closed to the untrusted class.

The run record and outcome carry the class `trusted_collaborator_fork_pull_request` with the author's permission, so how trust was granted is auditable after the fact.

Leave this off for public repositories: a fork proves nothing about its author there, and the default keeps every fork untrusted.

### Untrusted pull request

Fork (unless admitted as above) and Dependabot pull requests receive reduced capabilities:

- no provider secrets;
- no write tokens;
- no privileged tools;
- no pull-request code execution;
- no GitHub publication.

The static tracer may still perform limited review. The result is `partial_coverage` or another explicit non-clean outcome when verification is materially blocked.

### Privileged publisher

The publisher receives bounded, schema-validated data for one exact head SHA. It can publish confirmed effects but cannot execute pull-request code or reinterpret review output as instructions.

### Local CLI

A local invocation is authorized by the person running it. Local credentials, tools, and validation are permitted according to that invocation, but the result does not imply CI-grade trust and cannot publish to GitHub.

### Unsupported or unsafe

Unsupported events, unsafe policy, missing required state, and security-weakening configuration fail closed. They never degrade into a clean review.

## Base-branch policy

The Action reads `.diffowl.json` from the pull request's base revision rather than its head or a synthetic merge commit. This prevents a pull request from expanding its own capabilities, weakening review scope, or selecting a privileged credential profile.

## Credential boundary

Policy contains profile names, not keys. The Action maps trusted base-policy profiles to environment credentials populated from GitHub Secrets. Fork and Dependabot contexts cannot access them. GitHub itself withholds secrets from `pull_request` runs of fork heads, so this holds even if classification were wrong; collaborator forks are reviewed through the request-only `workflow_dispatch` path, which is why that path re-verifies the head.

Checkout uses `persist-credentials: false`. The GitHub token is supplied only to bounded state and publication operations, so validation commands cannot inherit repository credentials from the workspace.

Validation commands run the pull request's own code on the runner under a scrubbed environment (`PATH`, `CI`, and no-op git config only). The provider key is held by the Action process and never enters that environment or the role sandbox. What such a command can reach is whatever else the workflow job mounted, so keep the review job to checkout plus the Action, with the provider key as its only secret, and put dependency installation in `validationCommands` (for example `npm ci --ignore-scripts`) rather than in a workflow step.

## State boundary

GitHub-hosted trusted runs use dedicated Git refs. Self-hosted runs must use an explicit trusted directory. Diffowl does not silently fall back to comments, artifacts, caches, variables, or ephemeral workspace files when required durable state fails.

## Suggested-patch isolation

When enabled, suggested patches run against a disposable exact-head worktree inside a digest-pinned, pre-existing container image with:

- no network;
- an empty command environment;
- dropped capabilities and `no-new-privileges`;
- bounded CPU, memory, processes, storage, output, and time.

If isolation or proof is unavailable, the finding remains actionable without suggestion syntax.
