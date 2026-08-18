---
title: Trust model
description: How Diffowl classifies pull requests and constrains secrets, tools, validation, state, and publication.
---

Diffowl classifies trust before it reads pull-request-controlled repository content or starts provider-backed work. Trust is a product-level constraint; RunCell is not treated as a security boundary.

## Trust classes

### Trusted same-repository pull request

A branch in the base repository is reviewed under policy loaded from the base commit. It may use configured provider credentials, validation commands, durable state, and GitHub publication when required permissions are available.

### Untrusted pull request

Fork and Dependabot pull requests receive reduced capabilities:

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

Policy contains profile names, not keys. The Action maps trusted base-policy profiles to environment credentials populated from GitHub Secrets. Fork and Dependabot contexts cannot access them.

Checkout uses `persist-credentials: false`. The GitHub token is supplied only to bounded state and publication operations, so validation commands cannot inherit repository credentials from the workspace.

## State boundary

GitHub-hosted trusted runs use dedicated Git refs. Self-hosted runs must use an explicit trusted directory. Diffowl does not silently fall back to comments, artifacts, caches, variables, or ephemeral workspace files when required durable state fails.

## Suggested-patch isolation

When enabled, suggested patches run against a disposable exact-head worktree inside a digest-pinned, pre-existing container image with:

- no network;
- an empty command environment;
- dropped capabilities and `no-new-privileges`;
- bounded CPU, memory, processes, storage, output, and time.

If isolation or proof is unavailable, the finding remains actionable without suggestion syntax.
