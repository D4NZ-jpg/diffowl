---
title: Debugging failed runs
description: Reproduce Action runs locally, read diagnostics, and inspect execution artifacts.
---

Every non-clean outcome is typed, carries a reason, and preserves the evidence that was gathered before the run stopped. This guide shows where to look, in order.

## 1. Read the outcome type first

The Action's `outcome` output and the workflow summary both carry the typed outcome. Branch on `type`:

| You see                           | Start here                                                                                    |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `configuration_failure`           | Read `reason`. It names the exact policy field, missing credential profile, or setup problem. |
| `timeout`                         | `timeoutSeconds` is the exceeded budget. Reduce scope or raise `limits.reviewTimeoutSeconds`. |
| `budget_limit` / `resource_limit` | Read `reason`; check provider-side limits and validation output sizes.                        |
| `provider_failure`                | Read `reason`; check credentials, model names, and provider status.                           |
| `partial_coverage`                | Read `reason` plus `verification.coverageGaps`; often an untrusted-context restriction.       |
| `abstention`                      | Read `reason` plus `verification.limitations`; the engine refused to fake confidence.         |
| `internal_failure`                | File an issue with the reason string and run metadata.                                        |

From a workflow step, extract it directly:

```yaml
- run: echo '${{ steps.review-owl.outputs.outcome }}' | jq '{type, reason}'
```

## 2. Reproduce locally with the CLI

The CLI runs the same engine path, so most failures reproduce off CI:

```bash
# capture the same diff the Action reviewed
git fetch origin <base-sha> <head-sha>
git diff --no-color <base-sha>...<head-sha> > /tmp/pr.diff

# build the input file
jq -n --rawfile diff /tmp/pr.diff \
  '{repository: "owner/name", number: 42,
    baseSha: "<base-sha>", headSha: "<head-sha>", diff: $diff}' > /tmp/pr.json

node dist/cli.js review \
  --input /tmp/pr.json \
  --policy .diffowl.json \
  --state-directory /tmp/diffowl-state | jq .diagnostics
```

Differences from CI to keep in mind:

- trust is `local_cli`, so validation commands run with your local authorization instead of the sandbox;
- credentials resolve locally, so a CI-only credential problem will not reproduce;
- publishing is always denied, so publication issues need the Action logs instead.

## 3. Inspect verification state

For outcomes that carry `verification`, three fields explain most surprises:

```bash
node dist/cli.js review --input /tmp/pr.json --policy .diffowl.json \
  | jq '.verification | {limitations, coverageGaps, attempts: [.validationAttempts[] | {argv, status, exitCode}]}'
```

- `validationAttempts` shows each configured command with its `status`, `exitCode`, and captured output. A `timed_out` or `error` attempt often explains an abstention or a limitation.
- `limitations` lists verification constraints the engine attached to its conclusions.
- `coverageGaps` lists scoped work that was not completed.

## 4. Inspect execution artifacts

Each role execution (reviewer, challenger, verifier) captures an artifact with a session id, finish reason, event stream, and file snapshot. The report's `diagnostics.providerArtifactCount` tells you how many were captured; with a state directory, artifacts persist alongside the run record.

A `provider_failure` with zero artifacts means the failure happened before the role produced anything, which usually points at credentials or model configuration rather than review content.

## 5. Common failures

| Symptom                                                              | Likely cause and fix                                                                                                      |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `Credential profile "default" required by reviewer role is missing.` | The workflow does not export the provider variables the profile needs. See [Credentials](../credentials/).                |
| `Project policy ... unsupported field ...`                           | Policy fields are closed. Remove the field; check for typos.                                                              |
| `configuration_failure` mentioning state refs or markers             | Durable Git state was partially deleted or rewritten. Restore both refs together. See [Durable state](../durable-state/). |
| Every run is `policy_skip`                                           | `scope.includePaths` does not match the changed paths, or exclusions remove everything.                                   |
| Findings disappear and return between pushes                         | State directory or state refs are not durable between runs, so the ledger cannot reconcile.                               |
| `partial_coverage` on fork PRs                                       | Expected. Untrusted contexts deny secrets and validation commands by design.                                              |

## 6. When filing an issue

Include the typed outcome (`type`, `reason`), `run-metadata` from the Action output, the `diagnostics` block from a local reproduction, and your `.diffowl.json` with any private globs redacted. Never attach raw state directories; they can contain repository content.
