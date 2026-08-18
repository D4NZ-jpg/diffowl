---
title: Project policy
description: Configure review scope, limits, validation, review requests, and role profiles.
---

Project policy lives at `.diffowl.json`. The GitHub Action reads it from the trusted base commit; the local CLI reads the path supplied by the user.

Policy fields are closed. Unsupported active fields produce `configuration_failure` instead of being ignored.

## Complete shape

```json
{
  "version": 1,
  "scope": {
    "includePaths": ["src/**"],
    "excludePaths": ["dist/**"]
  },
  "limits": {
    "reviewTimeoutSeconds": 600,
    "maxFindings": 25
  },
  "verification": {
    "validationCommands": [{ "argv": ["npm", "test"], "timeoutSeconds": 300 }]
  },
  "reviewRequests": {
    "cooldownSeconds": 300
  },
  "roleProfiles": {
    "reviewer": {
      "provider": "openai",
      "model": "gpt-5",
      "credentialProfile": "default"
    },
    "challenger": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "credentialProfile": "default"
    },
    "verifier": {
      "provider": "openai",
      "model": "gpt-5-mini",
      "credentialProfile": "default"
    }
  }
}
```

## Scope

`scope.includePaths` and `scope.excludePaths` use glob patterns. Exclusions remove matching paths from review after inclusion. Keep generated, bundled, vendored, and binary output out of the review surface unless it is itself the product.

## Limits

| Field                  | Purpose                                             | Security ceiling |
| ---------------------- | --------------------------------------------------- | ---------------- |
| `reviewTimeoutSeconds` | Hard limit for the complete provider-backed review. | 3,600 seconds    |
| `maxFindings`          | Maximum material findings returned by one review.   | 100              |

Provider-reported budgets, resource limits, and the complete review timeout remain distinct typed outcomes.

## Validation commands

Commands are argv arrays, never shell strings:

```json
{
  "argv": ["npm", "test", "--", "src"],
  "timeoutSeconds": 120
}
```

A policy can configure at most 10 commands. Each timeout must be no greater than 600 seconds or the complete review timeout, whichever is lower. Captured stdout and stderr share a 64 KiB bound.

GitHub-hosted trusted runs can execute configured commands in the externally isolated ephemeral job. Built-in host execution is unavailable by default on self-hosted or unknown runners. Local CLI execution is explicitly user-authorized and does not count as CI trust evidence.

## Suggested patches

`verification.suggestedPatches` is optional. It requires:

- a digest-pinned container image already present on the runner;
- ordered path rules mapped to configured validation commands;
- one contiguous changed-line region in an existing text file;
- a maximum of 20 source lines and 20 replacement lines.

Diffowl rejects suggestions for workflows, credentials, permissions, dependency manifests, lockfiles, generated or vendored content, binaries, links, submodules, and multi-file changes.

## Review requests

`reviewRequests.cooldownSeconds` defaults to 300. The non-overridable security minimum is 60 seconds.

## Role profiles

Every policy defines `reviewer`, `challenger`, and `verifier` profiles. Each profile supplies:

- `provider`
- `model`
- `credentialProfile`

The trusted adapter resolves the profile to RunCell credentials. Raw keys never enter project policy or role-execution requests.
