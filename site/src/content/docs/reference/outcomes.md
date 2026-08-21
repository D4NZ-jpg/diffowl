---
title: Review outcomes
description: The typed outcome union, material finding shape, verification states, and finding lifecycle.
---

Every run returns one typed outcome. Incomplete work cannot be serialized as `clean`.

## Outcome types

| Type                    | Category            | Meaning                                                                          |
| ----------------------- | ------------------- | -------------------------------------------------------------------------------- |
| `clean`                 | completed           | Completed permitted coverage found no material findings.                         |
| `findings`              | completed           | Completed permitted coverage produced one or more material findings.             |
| `partial_coverage`      | coverage            | Only a constrained subset of meaningful work completed. Common for untrusted PRs. |
| `policy_skip`           | coverage            | Base-branch project policy deterministically excluded the change.                |
| `unsupported_change`    | coverage            | The pull request or change shape is outside supported behavior.                  |
| `abstention`            | coverage            | Available evidence supports neither a material claim nor a defensible clean.     |
| `budget_limit`          | limit               | A provider or configured budget prevented completion.                            |
| `resource_limit`        | limit               | A bounded execution resource was exhausted.                                      |
| `timeout`               | limit               | The complete review exceeded `limits.reviewTimeoutSeconds`.                      |
| `provider_failure`      | failure             | A configured role failed at the provider boundary.                               |
| `configuration_failure` | failure             | Policy, permissions, credentials, state, or setup is invalid.                    |
| `internal_failure`      | failure             | An unexpected engine or adapter failure prevented a defensible result.           |

## Fields by outcome type

Every outcome carries `trust` (the trust classification) and, when durable state is configured, `run` (run metadata). Beyond that, fields accumulate with how far the run progressed:

| Field                                       | Present on                                                                    |
| ------------------------------------------- | ----------------------------------------------------------------------------- |
| `pullRequest`                               | Everything except `policy_skip` and `unsupported_change`.                     |
| `policy` (`source` + `effective`)           | Every configured outcome. `configuration_failure` carries `policySource` only. |
| `reason`                                    | Every non-completed outcome except `timeout`, which carries `timeoutSeconds`. |
| `materialFindings`                          | `clean` (always `[]`), `findings` (non-empty), `abstention`, `partial_coverage` (optional). |
| `advisorySuggestions`                       | `clean`, `findings`, `abstention`, `partial_coverage` (optional).             |
| `verification`                              | `clean`, `findings`, `abstention`, `partial_coverage` (optional).             |
| `orchestrationPlan`                         | `clean`, `findings`, `partial_coverage` (optional).                           |
| `executionArtifacts`                        | Completed, abstained, limit, and provider-failure outcomes.                   |
| `coverage: "completed_permitted"`           | `clean` and `findings` only.                                                  |

Two consequences worth noting:

- A `timeout`, `budget_limit`, or `provider_failure` run still exposes `executionArtifacts`, so partial role executions remain inspectable.
- Only `clean` and `findings` carry `coverage: "completed_permitted"`. Any consumer treating another type as complete is wrong.

## Material findings

```json
{
  "fingerprint": "…",
  "summary": "Deleting the retry guard drops queued webhooks on transient failures.",
  "location": { "path": "src/webhook-queue.ts", "startLine": 118, "line": 131 },
  "impact": "Transient provider errors permanently discard events.",
  "evidence": [
    {
      "id": "e1",
      "type": "scoped_diff",
      "path": "src/webhook-queue.ts",
      "content": "…",
      "truncated": false
    }
  ],
  "lifecycleState": "new",
  "verificationState": {
    "type": "verified_with_limitations",
    "explanation": "…",
    "limitations": ["No integration test exercises the retry path."]
  }
}
```

| Field               | Meaning                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `fingerprint`       | Stable engine-generated identity. Line numbers and thread ids are hints, not identity.   |
| `summary`, `impact` | The material claim and why it matters.                                                   |
| `location`          | `path` plus optional `startLine` and `line`.                                             |
| `evidence`          | Evidence records from the verification catalog (below).                                  |
| `lifecycleState`    | Ledger state (below).                                                                    |
| `verificationState` | `verified` (empty `limitations`) or `verified_with_limitations` (non-empty).             |
| `suggestedPatch`    | Optional validated patch, present only when suggested-patch policy is configured.        |

Advisory suggestions are a separate, simpler shape (`summary`, `rationale`, optional `location`) and never make a review non-clean by themselves.

## Evidence and verification

Verification context accompanies completed and abstained outcomes:

| Field                | Meaning                                                                  |
| -------------------- | ------------------------------------------------------------------------ |
| `evidenceCatalog`    | All evidence records gathered during verification.                       |
| `validationAttempts` | One record per validation command execution.                             |
| `limitations`        | Verification limits the engine wants humans to know about.               |
| `coverageGaps`       | Scoped work that could not be completed.                                 |

Evidence records are one of three types, each with `id`, `content`, and `truncated`:

| Type              | Extra fields   | Source                                             |
| ----------------- | -------------- | -------------------------------------------------- |
| `scoped_diff`     | `path`         | The reviewed diff, scoped to policy paths.         |
| `repository_file` | `path`         | Head-revision file content, capped at 64 KiB.      |
| `validation`      | `commandIndex` | Output of a configured validation command.         |

Validation attempts record `argv`, `timeoutSeconds`, a `status` of `passed`, `failed`, `timed_out`, `aborted`, or `error`, plus `exitCode`, `stdout`, `stderr`, `truncated`, and an optional `limitation`.

## Finding lifecycle

The ledger reconciles findings across pushes and reruns by fingerprint:

| State        | Meaning                                                       |
| ------------ | ------------------------------------------------------------- |
| `new`        | First seen in this run.                                       |
| `persisting` | Seen in a prior run and still present.                        |
| `resolved`   | Marked resolved by the author or verified as fixed.           |
| `obsolete`   | The underlying code or claim no longer exists.                |
| `rebutted`   | Successfully challenged by the author.                        |
| `accepted`   | Explicitly accepted by the author.                            |
| `suppressed` | Suppressed through policy or an audited command.              |

## Review readiness

The GitHub workflow check is the readiness surface:

- **success:** ready for targeted human review;
- **failure with findings:** return to the author;
- **failure without a defensible result:** inspect setup, limits, provider, or internal diagnostics;
- **skipped:** deterministic project-policy exclusion;
- **cancelled:** a newer revision superseded the run.

:::caution
A successful check does not mean "approved" or "correct." It means Diffowl completed the work permitted by policy and trust, and the pull request is ready for human judgment.
:::

## Publication results

Publication is reported separately as `complete`, `not_attempted`, `refused`, or `incomplete`. Confirmed partial effects stay in the result for reconciliation. Publication failure does not rewrite the engine outcome.
