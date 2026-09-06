---
title: Durable state and self-hosting
description: Where Diffowl stores review state, how Git-ref state works, and how to run self-hosted safely.
---

Diffowl keeps run records, the finding ledger, and execution artifacts in durable state so finding identity survives pushes, reruns, and discussion commands. No hosted database is involved. Where that state lives depends on how you run the Action.

## GitHub-hosted runners: Git-ref state

On GitHub-hosted runners, Diffowl stores state in dedicated refs of the base repository under `refs/diffowl/state/`:

```text
refs/diffowl/state/marker
refs/diffowl/state/repositories/<owner>/<name>/pull-requests/<number>/state
refs/diffowl/state/repositories/<owner>/<name>/pull-requests/<number>/marker
```

This is why the canonical workflow needs `contents: write` and `fetch-depth: 0`. The `self-hosted-state-directory` input is ignored on GitHub-hosted runners.

The marker refs protect against tampering and partial restores. If Diffowl reports that a state ref or marker is missing, rewritten, or inconsistent, restore both the state ref and its marker from the base repository. Do not "fix" the error by falling back to comments, checks, artifacts, caches, or repository variables; those surfaces are not trusted state.

To intentionally reset state for a pull request, delete the state ref and its marker together.

## Self-hosted runners: filesystem state

Explicit self-hosted runs must pass a trusted durable directory:

```yaml
- uses: D4NZ-jpg/diffowl@v0
  with:
    self-hosted-state-directory: /srv/diffowl-state
```

Requirements for the directory:

- it survives separate workflow invocations (not a per-job temp directory);
- it is not under pull-request-controlled content;
- it is never published as a workflow artifact;
- it is private to the runner and included in your backup and audit process.

Diffowl permission-restricts the directory, but the runner host remains your responsibility.

## Local CLI state

The CLI persists to the directory passed as `--state-directory`. Reusing the directory across runs reconciles finding lifecycle exactly like CI state does. See the [CLI reference](../../reference/cli/).

## The trusted request router

Manual review requests and `/diffowl ...` finding commands use a two-workflow design so that no workflow triggered by untrusted content ever holds provider secrets:

1. **Router** (`review-request.yml`): triggered by comments. Carries no provider secrets, checks out only the default branch, authenticates the actor, records a durable command event, and dispatches the review workflow with verified inputs.
2. **Review workflow** (`review-owl.yml`): runs on `pull_request` events and on `workflow_dispatch` from the router. Holds the provider secrets and performs the review.

Install both from [`examples/representative-repository`](https://github.com/D4NZ-jpg/diffowl/tree/main/examples/representative-repository):

```yaml title=".github/workflows/review-request.yml"
name: Review OWL request

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  actions: write
  contents: write
  pull-requests: write
  issues: write

jobs:
  route:
    if: ${{ startsWith(github.event.comment.body, '/diffowl ') && (github.event_name == 'pull_request_review_comment' || github.event.issue.pull_request) }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.repository.default_branch }}
          fetch-depth: 0
          persist-credentials: false
      - uses: D4NZ-jpg/diffowl/review-request@v0
        with:
          workflow: review-owl.yml
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

The dispatched review workflow receives `repository`, `pull-request-number`, `base-sha`, `head-sha`, `review-request-event-id`, and the finding-command inputs as verified values. The durable command event id is what authorizes the dispatched work; a dispatch without a recorded event is refused.

`reviewRequests.cooldownSeconds` in project policy rate-limits accepted manual requests (default 300 seconds, minimum 60).

## What state contains

| Artifact             | Contents                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Finding ledger       | Fingerprints, lifecycle states, and disposition history per pull request.                  |
| Run records          | PR and head SHA, trust class, policy hash, engine version, budget envelope, typed outcome. |
| Execution artifacts  | RunCell session snapshots, events, and files per role execution.                           |
| Publication receipts | Adapter-owned confirmations for reviews, checks, and summaries.                            |

Run records are versioned; safe metadata (never secrets) is exposed through the Action's `run-metadata` output.
