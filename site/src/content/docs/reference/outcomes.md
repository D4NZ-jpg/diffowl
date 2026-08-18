---
title: Review outcomes
description: Interpret clean, findings, partial, skipped, limited, failed, and abstained reviews.
---

Every run returns one typed outcome. Incomplete work cannot be serialized as `clean`.

## Completed outcomes

| Type       | Meaning                                                                         |
| ---------- | ------------------------------------------------------------------------------- |
| `clean`    | Completed permitted coverage found no material findings.                        |
| `findings` | Completed permitted coverage produced one or more actionable material findings. |

Completed outcomes use `coverage: "completed_permitted"`. Advisory suggestions remain separate and do not make a review non-clean by themselves.

## Coverage and policy outcomes

| Type                 | Meaning                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| `partial_coverage`   | Review completed only a constrained subset of meaningful work. Common for untrusted pull requests. |
| `policy_skip`        | Base-branch project policy deterministically excluded the change.                                  |
| `unsupported_change` | The pull request or change shape is outside supported behavior.                                    |
| `abstention`         | The engine cannot support a material claim or defensible clean result with available evidence.     |

## Limit and failure outcomes

| Type                    | Meaning                                                                |
| ----------------------- | ---------------------------------------------------------------------- |
| `budget_limit`          | A provider or configured budget prevented completion.                  |
| `resource_limit`        | A bounded execution resource was exhausted.                            |
| `timeout`               | The complete review exceeded its hard timeout.                         |
| `provider_failure`      | A configured role failed at the provider boundary.                     |
| `configuration_failure` | Policy, permissions, credentials, state, or setup is invalid.          |
| `internal_failure`      | An unexpected engine or adapter failure prevented a defensible result. |

## Review readiness

The GitHub workflow check is the readiness surface:

- **success** — ready for targeted human review;
- **failure with findings** — return to the author;
- **failure without a defensible result** — inspect setup, limits, provider, or internal diagnostics;
- **skipped** — deterministic project-policy exclusion;
- **cancelled** — a newer revision superseded the run.

:::caution
A successful check does not mean “approved” or “correct.” It means Diffowl completed the work permitted by policy and trust, and the pull request is ready for human judgment.
:::

## Publication results

Publication is reported separately as `complete`, `not_attempted`, `refused`, or `incomplete`. Confirmed partial effects stay in the result for reconciliation. Publication failure does not rewrite the engine outcome.
