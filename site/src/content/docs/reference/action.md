---
title: Action inputs and outputs
description: Reference for the Review OWL Action and trusted request router.
---

## Review OWL Action

```yaml
uses: D4NZ-jpg/diffowl@v0
```

The Action runtime is Node.js 24.

### Inputs

Inputs are optional for direct `pull_request` events and supplied by the trusted router for authenticated `workflow_dispatch` work.

| Input                         | Purpose                                                                                                                        |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `self-hosted-state-directory` | Trusted durable filesystem state for explicit self-hosted runs. Ignored by GitHub-hosted runs.                                 |
| `repository`                  | Base repository for an authenticated dispatched request.                                                                       |
| `pull-request-number`         | Pull-request number for dispatched work.                                                                                       |
| `base-sha`                    | Verified base revision.                                                                                                        |
| `head-sha`                    | Verified head revision.                                                                                                        |
| `head-repository`             | Verified head repository. Equals the base repository unless policy admitted a collaborator fork; the workflow checks this out. |
| `review-request-event-id`     | Durable command-event identity authorizing the work.                                                                           |
| `command-work-type`           | Route selected by the trusted default-branch router.                                                                           |
| `finding-fingerprint`         | Stable finding identity for bounded discussion work.                                                                           |
| `finding-context`             | Author-supplied context for reassessment.                                                                                      |
| `finding-root-comment-id`     | Stable root review-comment identity.                                                                                           |

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

### Environment

| Variable                          | Meaning                                                                                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GITHUB_TOKEN`                    | Required. Consumed for state refs and publication and removed from the environment before any role runs.      |
| `DIFFOWL_CREDENTIAL_STORE_URL`    | Postgres connection string for the shared credential store. When set, the `default` profile resolves from it. |
| `DIFFOWL_CREDENTIAL_STORE_KEY`    | Row key in the store. Default `diffowl-default`.                                                              |
| `DIFFOWL_CREDENTIAL_STORE_SECRET` | Optional encryption key for the stored blob.                                                                  |
| `*_API_KEY`, `*_BASE_URL`         | Provider keys for the `default` profile when no store URL is set, for example `ANTHROPIC_API_KEY`.            |

The three `DIFFOWL_CREDENTIAL_STORE_*` variables are consumed and deleted from the environment when the Action starts. See the [credentials guide](../../guides/credentials/).

## Request router

```yaml
uses: D4NZ-jpg/diffowl/review-request@v0
```

The router Action accepts one optional input:

| Input      | Default          | Purpose                                                        |
| ---------- | ---------------- | -------------------------------------------------------------- |
| `workflow` | `review-owl.yml` | Default-branch workflow file to dispatch after authentication. |

The router runtime is Node.js 24 and requires `actions: write`, `contents: write`, `pull-requests: write`, and `issues: write` in the representative workflow.
