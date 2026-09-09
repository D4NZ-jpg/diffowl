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

## Token boundary

The workflow token carries `contents: write` and `pull-requests: write`, which on their own reach every branch and every pull request in the repository. Diffowl does not rely on the permission grant to bound what it does. The token is read once when the Action starts and removed from the process environment; it is then held only by two closures, an API transport and a git push environment, and both enforce an allowlist before the token is attached to anything.

The API transport is bound to `GITHUB_REPOSITORY`, which the runner sets from the workflow's own repository and no event or input can change. Every request must match one of the shapes below on that repository; anything else throws before any network call. GraphQL is limited to three named operations, one per document. Model output only ever becomes a request body, never a path or method, and a review is always posted with `event: COMMENT`.

| Role           | Method          | Path under `/repos/{repository}`                                        |
| -------------- | --------------- | ----------------------------------------------------------------------- |
| review, router | GET             | `/pulls/{n}`                                                            |
| review         | GET             | `/pulls/{n}/reviews`                                                    |
| review, router | GET             | `/pulls/{n}/comments`                                                   |
| router         | GET             | `/pulls/comments/{id}`                                                  |
| review, router | GET             | `/issues/{n}/comments`                                                  |
| review, router | GET             | `/collaborators/{login}/permission`                                     |
| review         | POST            | `/pulls/{n}/reviews` (always `COMMENT`)                                 |
| review         | POST            | `/pulls/{n}/comments`                                                   |
| review, router | POST            | `/pulls/{n}/comments/{id}/replies`                                      |
| review, router | POST            | `/issues/{n}/comments`                                                  |
| router         | POST            | `/issues/comments/{id}/reactions`, `/pulls/comments/{id}/reactions`     |
| router         | POST            | `/actions/workflows/{file}/dispatches` (ref is the default branch)      |
| review         | POST `/graphql` | `DiffowlFindingThread`, `DiffowlResolveFinding`, `DiffowlReopenFinding` |

Not reachable, regardless of permission: branches, tags, releases, merges, approvals, issues other than the pull request, other workflows, secrets, variables, repository settings, or any other repository. The list is generated from the same table the transport enforces (`scopeSurface()` in `github-scope.ts`), and the threat suite asserts each of those refusals with no network call made.

The git side has the same shape. The only remote write is `git push --atomic` of refs under `refs/diffowl/state/`; the argv guard refuses `--force`, `--force-with-lease`, `+` refspecs, `--delete`, `--tags`, `--mirror`, and any destination outside that prefix. The permission probe is a `--dry-run` push that writes nothing.

`contents: write` is still wider than the state refs need, because GitHub cannot scope a token to a ref prefix. To make the surplus inert at the repository level, add a ruleset on `refs/heads/*` and `refs/tags/*` that restricts updates and does not list the GitHub Actions app in its bypass list.

## State boundary

GitHub-hosted trusted runs use dedicated Git refs. Self-hosted runs must use an explicit trusted directory. Diffowl does not silently fall back to comments, artifacts, caches, variables, or ephemeral workspace files when required durable state fails.

## Suggested-patch isolation

When enabled, suggested patches run against a disposable exact-head worktree inside a digest-pinned, pre-existing container image with:

- no network;
- an empty command environment;
- dropped capabilities and `no-new-privileges`;
- bounded CPU, memory, processes, storage, output, and time.

If isolation or proof is unavailable, the finding remains actionable without suggestion syntax.
