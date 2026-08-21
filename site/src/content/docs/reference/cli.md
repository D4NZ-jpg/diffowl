---
title: CLI reference
description: Complete reference for the diffowl review command, input schema, report shape, and exit codes.
---

The CLI runs the same review engine contract as the GitHub Action. It is a reproduction and inspection tool; its output is never CI trust evidence.

## Synopsis

```text
diffowl review --input <pull-request.json> --policy <local-policy.json> [options]
```

From a repository clone:

```bash
npm install
npm run build
node dist/cli.js review \
  --input pull-request.json \
  --policy .diffowl.json \
  --state-directory .diffowl-state
```

## Options

| Option                     | Required | Meaning                                                                        |
| -------------------------- | -------- | ------------------------------------------------------------------------------ |
| `--input <path>`           | yes      | Path to the pull-request input JSON.                                           |
| `--policy <path>`          | yes      | Path to a local project-policy JSON file.                                      |
| `--state-directory <path>` | no       | Persist and inspect local run records and finding-ledger state.                |
| `--dry-run`                | no       | Run locally without publishing. This is the default.                           |
| `--publish`                | no       | Request publishing mode; the `local_cli` trust class still denies publication. |

Unknown arguments and missing option values print usage on stderr and exit with code 2.

## Exit codes

| Code | Meaning                                                                             |
| ---- | ----------------------------------------------------------------------------------- |
| 0    | The engine produced a typed outcome. This includes non-clean outcomes like `findings` or `timeout`. |
| 1    | The review threw: unreadable files, invalid policy JSON path, or an engine error.   |
| 2    | Argument errors or pull-request input that does not match the required schema.      |

The exit code reflects whether a typed outcome was produced, not whether the review was clean. Read `outcome.type` from the report to branch on the result.

## Pull-request input schema

```json title="pull-request.json"
{
  "repository": "example/review-target",
  "number": 42,
  "baseSha": "1111111111111111111111111111111111111111",
  "headSha": "2222222222222222222222222222222222222222",
  "diff": "diff --git ..."
}
```

| Field        | Type    | Constraint                              |
| ------------ | ------- | --------------------------------------- |
| `repository` | string  | `owner/name` form.                      |
| `number`     | integer | Pull-request number.                    |
| `baseSha`    | string  | Base revision the diff applies against. |
| `headSha`    | string  | Head revision under review.             |
| `diff`       | string  | Unified diff of the change.             |

Capture a real diff with:

```bash
git diff --no-color <base-sha>...<head-sha>
```

## Report shape

The CLI writes one JSON document to stdout:

```json
{
  "adapter": "local_cli",
  "mode": "dry-run",
  "ciTrusted": false,
  "trust": { "class": "local_cli", "capabilities": { "publishing": "denied" } },
  "publishing": {
    "requested": false,
    "status": "not_attempted",
    "note": "Local CLI output is reproduction data only; it is not GitHub Action trust evidence."
  },
  "outcome": { "type": "findings" },
  "findings": [],
  "advisorySuggestions": [],
  "verification": {},
  "runRecord": {},
  "ledger": {},
  "diagnostics": {
    "outcomeType": "findings",
    "validationAttemptCount": 1,
    "providerArtifactCount": 3
  }
}
```

| Field                 | Present            | Meaning                                                                      |
| --------------------- | ------------------ | ---------------------------------------------------------------------------- |
| `adapter`             | always             | Always `local_cli`.                                                          |
| `mode`                | always             | `dry-run` or `publish`.                                                      |
| `ciTrusted`           | always             | Always `false`.                                                              |
| `trust`               | always             | The `local_cli` trust classification and its capability set.                 |
| `publishing`          | always             | Always `not_attempted`; `requested` records whether `--publish` was passed.  |
| `outcome`             | always             | The complete typed [review outcome](../outcomes/).                           |
| `findings`            | always             | Material findings from the outcome, or `[]`.                                 |
| `advisorySuggestions` | always             | Advisory suggestions from the outcome, or `[]`.                              |
| `verification`        | always             | Evidence catalog, validation attempts, limitations, and coverage gaps.       |
| `runRecord`           | with state dir     | The persisted versioned run record for this run.                             |
| `ledger`              | with state dir     | The reconciled finding ledger after this run.                                |
| `diagnostics`         | always             | Outcome type, reason, timeout seconds, attempt and artifact counts.          |

### `diagnostics`

| Field                    | Present                | Meaning                                              |
| ------------------------ | ---------------------- | ---------------------------------------------------- |
| `outcomeType`            | always                 | Mirror of `outcome.type` for quick filtering.        |
| `reason`                 | outcomes with a reason | The typed outcome's reason string.                   |
| `timeoutSeconds`         | `timeout` outcomes     | The exceeded hard timeout.                           |
| `validationAttemptCount` | always                 | Number of validation command attempts executed.      |
| `providerArtifactCount`  | always                 | Number of role execution artifacts captured.         |
| `ledgerEntryCount`       | with state dir         | Entries in the persisted finding ledger.             |

Useful one-liners:

```bash
node dist/cli.js review --input pr.json --policy .diffowl.json | jq .diagnostics
node dist/cli.js review --input pr.json --policy .diffowl.json | jq '.findings[].summary'
```

## Local persistence

Reusing the same `--state-directory` across runs reconciles finding lifecycle without a hosted database: a finding that persists across pushes keeps its fingerprint and moves through `new`, `persisting`, `resolved`, and related states.

Diffowl permission-restricts the directory, but you remain responsible for keeping it private, trusted, and backed up according to your audit requirements.

## Credentials and trust

Local runs classify trust as `local_cli`:

- validation commands, secrets, and tools are `local_user_authorized`;
- publishing is `denied`, regardless of `--publish`.

The default credential profile is `local`, which resolves provider credentials through local RunCell configuration, including supported Codex or Claude logins. See [Credentials and providers](../../guides/credentials/).
