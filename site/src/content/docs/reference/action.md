---
title: Action inputs and outputs
description: Reference for the Review OWL Action and trusted request router.
---

## Review OWL Action

```yaml
uses: D4NZ-jpg/diffowl@main
```

The Action runtime is Node.js 24.

### Inputs

Inputs are optional for direct `pull_request` events and supplied by the trusted router for authenticated `workflow_dispatch` work.

| Input                         | Purpose                                                                                        |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `self-hosted-state-directory` | Trusted durable filesystem state for explicit self-hosted runs. Ignored by GitHub-hosted runs. |
| `repository`                  | Base repository for an authenticated dispatched request.                                       |
| `pull-request-number`         | Pull-request number for dispatched work.                                                       |
| `base-sha`                    | Verified base revision.                                                                        |
| `head-sha`                    | Verified head revision.                                                                        |
| `review-request-event-id`     | Durable command-event identity authorizing the work.                                           |
| `command-work-type`           | Route selected by the trusted default-branch router.                                           |
| `finding-fingerprint`         | Stable finding identity for bounded discussion work.                                           |
| `finding-context`             | Author-supplied context for reassessment.                                                      |
| `finding-root-comment-id`     | Stable root review-comment identity.                                                           |

### Outputs

| Output         | Description                                              |
| -------------- | -------------------------------------------------------- |
| `outcome`      | Typed review outcome JSON.                               |
| `run-id`       | Persisted run identifier when durable state succeeds.    |
| `run-metadata` | Safe persisted run metadata JSON.                        |
| `publication`  | Adapter-owned publication result and confirmed receipts. |

### Permissions

The canonical trusted workflow uses:

```yaml
permissions:
  contents: write
  pull-requests: write
  issues: read
```

`contents: write` advances dedicated state refs. `pull-requests: write` publishes the review. Missing required permissions produce explicit configuration or publication failure.

## Request router

```yaml
uses: D4NZ-jpg/diffowl/review-request@main
```

The router Action accepts one optional input:

| Input      | Default          | Purpose                                                        |
| ---------- | ---------------- | -------------------------------------------------------------- |
| `workflow` | `review-owl.yml` | Default-branch workflow file to dispatch after authentication. |

The router runtime is Node.js 24 and requires `actions: write`, `contents: write`, `pull-requests: write`, and `issues: write` in the representative workflow.
