---
title: GitHub Action
description: Install the basic review workflow, the trusted command router, and self-hosted persistence.
---

Diffowl's GitHub integration has two boundaries:

1. the **Review OWL Action**, which adapts a verified pull-request context to the review engine;
2. the optional **request router**, which authenticates comment commands before dispatching the canonical workflow.

## Request-only review

The [quick start](../quick-start/) installs the recommended shape: a router on comments plus a review workflow that only accepts the router's `workflow_dispatch`. Nothing runs until someone comments `/diffowl review`.

## Automatic review on every pull request

To also review on push, add a `pull_request` trigger to `review-owl.yml` and let the checkout fall back to the event head:

```yaml
on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      # same inputs as the quick start

jobs:
  review:
    steps:
      - uses: actions/checkout@v4
        with:
          repository: ${{ inputs.head-repository || github.event.pull_request.head.repo.full_name || github.repository }}
          ref: ${{ inputs.head-sha || github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: D4NZ-jpg/diffowl@v0
        # inputs and env as in the quick start
```

On `pull_request` events GitHub withholds repository secrets from fork heads, so fork pull requests on this trigger are classified untrusted and produce `partial_coverage` without a model call. Use `pull_request`, never `pull_request_target`.

The review workflow requires:

- a full-history checkout of the exact head SHA;
- `contents: write` for durable Git-ref state on GitHub-hosted runners;
- `pull-requests: write` for review publication;
- `issues: read` for pull-request and discussion context;
- either the credential-store secrets or the provider keys referenced by base-branch policy, and nothing else in that job.

## Review and finding commands

To support `/diffowl review` and inline finding commands, install both representative workflows:

- [`review-owl.yml`](https://github.com/D4NZ-jpg/diffowl/blob/main/examples/representative-repository/.github/workflows/review-owl.yml) accepts verified `workflow_dispatch` inputs in addition to pull-request events.
- [`review-request.yml`](https://github.com/D4NZ-jpg/diffowl/blob/main/examples/representative-repository/.github/workflows/review-request.yml) runs on new issue and review comments.

The router checks out only the default branch, carries no provider secrets, authenticates the actor against the latest same-repository pull-request head, records the event, and dispatches the canonical workflow at the default-branch ref.

:::danger[Do not put provider secrets in the router]
The comment router processes user-authored event content. Keep provider credentials in the canonical review workflow only.
:::

## Durable state

### GitHub-hosted runners

Trusted same-repository runs store finding ledgers and versioned run records under dedicated base-repository refs in `refs/diffowl/state/...`. Ref updates are non-forcing and bounded. Missing permissions, corrupt state, deleted refs, or apparent rewrites produce a configuration failure.

### Self-hosted runners

Set the Action input `self-hosted-state-directory` to a trusted, durable directory that survives separate workflow invocations.

```yaml
- uses: D4NZ-jpg/diffowl@v0
  with:
    self-hosted-state-directory: /var/lib/diffowl/state
```

Do not place this directory under pull-request-controlled content or upload it as an artifact. GitHub-hosted runs ignore this input and always use Git-ref state.

## Publication behavior

The engine returns data; the adapter owns GitHub effects. When actionable findings exist, Diffowl publishes one non-approving pull-request review. Changed-line findings become inline comments, while unanchored findings appear in the review body. Non-blocking suggestions appear according to `presentation.advisories` in policy: folded into one collapsed block by default.

The existing workflow check is the merge-gating surface. Diffowl does not create a duplicate check or a maintained summary comment.
