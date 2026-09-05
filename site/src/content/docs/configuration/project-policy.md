---
title: Project policy
description: Field-by-field reference for .diffowl.json, including security ceilings and fail-closed behavior.
---

Project policy lives at `.diffowl.json`. The GitHub Action reads it from the trusted base commit; the local CLI reads the path supplied by the user.

Policy fields are closed. Any unsupported field, at any nesting level, produces a `configuration_failure` outcome instead of being ignored. Invalid JSON and a missing file also fail closed.

## Complete shape

```json title=".diffowl.json"
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
    "validationCommands": [{ "argv": ["npm", "test"], "timeoutSeconds": 300 }],
    "suggestedPatches": {
      "sandboxImage": "ghcr.io/example/validator@sha256:6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b",
      "validationRules": [{ "includePaths": ["src/**"], "commandIndex": 0 }]
    }
  },
  "reviewRequests": {
    "cooldownSeconds": 300
  },
  "presentation": {
    "advisories": "summary"
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

Required top-level fields: `version`, `scope`, `limits`, `verification`, `roleProfiles`. Optional: `reviewRequests`, `presentation`.

## `version`

Must be the integer `1`. Any other value is a configuration failure.

## `scope`

| Field          | Type       | Required | Meaning                                        |
| -------------- | ---------- | -------- | ---------------------------------------------- |
| `includePaths` | `string[]` | yes      | Glob patterns selecting paths to review.       |
| `excludePaths` | `string[]` | yes      | Glob patterns removed after inclusion matches. |

Both arrays must contain non-empty strings. Exclusions win over inclusions. Keep generated, bundled, vendored, and binary output out of the review surface unless it is itself the product.

When no changed path survives scoping, the run returns a `policy_skip` outcome.

## `limits`

| Field                  | Type             | Ceiling | Meaning                                             |
| ---------------------- | ---------------- | ------- | --------------------------------------------------- |
| `reviewTimeoutSeconds` | positive integer | 3,600   | Hard limit for the complete provider-backed review. |
| `maxFindings`          | positive integer | 100     | Maximum material findings returned by one review.   |

Values above a ceiling are a configuration failure, not a clamp. Exceeding `reviewTimeoutSeconds` at runtime produces a `timeout` outcome; provider budgets and resource exhaustion produce the distinct `budget_limit` and `resource_limit` outcomes.

## `verification.validationCommands`

An array of at most 10 commands. Each command:

| Field            | Type             | Constraint                                                        |
| ---------------- | ---------------- | ----------------------------------------------------------------- |
| `argv`           | `string[]`       | Non-empty array of non-empty strings. Argv, never a shell string. |
| `timeoutSeconds` | positive integer | At most 600, and at most `limits.reviewTimeoutSeconds`.           |

Validation commands run only in contexts whose trust class permits them: sandboxed in trusted same-repo Action runs, user-authorized in local CLI runs, denied for fork and Dependabot pull requests. Command output is captured with a 64 KiB cap per attempt and recorded as verification evidence.

## `verification.suggestedPatches` (optional)

Enables isolated validation of suggested patches before they become GitHub suggestion blocks.

| Field             | Type     | Constraint                                                        |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `sandboxImage`    | `string` | Must be a digest-pinned image reference (`name@sha256:<64 hex>`). |
| `validationRules` | array    | At most 10 rules.                                                 |

Each rule:

| Field          | Type       | Constraint                                                           |
| -------------- | ---------- | -------------------------------------------------------------------- |
| `includePaths` | `string[]` | Non-empty strings; patch paths this rule applies to.                 |
| `commandIndex` | integer    | Zero-based index into `verification.validationCommands`. Must exist. |

Tag-only image references are rejected. Pinning by digest keeps the validation environment reproducible and prevents tag-swap substitution.

## `reviewRequests` (optional)

| Field             | Type             | Default | Minimum | Meaning                                                |
| ----------------- | ---------------- | ------- | ------- | ------------------------------------------------------ |
| `cooldownSeconds` | positive integer | 300     | 60      | Minimum delay between accepted manual review requests. |

Values below the 60-second security minimum are a configuration failure.

## `presentation` (optional)

Controls where non-blocking advisory suggestions appear on GitHub. Material Findings are always published and are not affected.

| Field        | Values                     | Default   | Meaning                                                                                                                                                                                                                                                                            |
| ------------ | -------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `advisories` | `off`, `summary`, `inline` | `summary` | `off`: suggestions stay in the engine outcome only. `summary`: one collapsed block at the end of the pull-request review plus a count in the job summary. `inline`: each suggestion anchored to a changed line becomes its own review comment; the rest go in the collapsed block. |

Suggestions never change Review readiness or the check conclusion. A `clean` review with suggestions publishes a non-approving comment review containing only the collapsed block. Start with `summary`; switch to `inline` if the team acts on suggestions, or `off` if they add noise.

## `roleProfiles`

Exactly three roles are supported: `reviewer`, `challenger`, and `verifier`. Each profile requires:

| Field               | Type   | Meaning                                                      |
| ------------------- | ------ | ------------------------------------------------------------ |
| `provider`          | string | Provider identifier passed to the RunCell execution layer.   |
| `model`             | string | Model identifier for that provider.                          |
| `credentialProfile` | string | Named credential profile resolved by the adapter at runtime. |

The policy names credential profiles; it never contains raw secrets. See [Credentials and providers](../../guides/credentials/) for how profiles resolve in each adapter.

## Security ceilings

Ceilings are non-overridable. Policy that exceeds them fails closed.

| Ceiling                       | Value   |
| ----------------------------- | ------- |
| `reviewTimeoutSeconds`        | 3,600 s |
| `maxFindings`                 | 100     |
| Validation command count      | 10      |
| Validation command timeout    | 600 s   |
| Validation output per attempt | 64 KiB  |
| Repository evidence per file  | 64 KiB  |

## Failure behavior

All policy problems produce a `configuration_failure` outcome carrying a specific reason string, for example:

```text
Project policy limits.reviewTimeoutSeconds exceeds the security ceiling of 3600.
Project policy verification.validationCommands[1].timeoutSeconds exceeds limits.reviewTimeoutSeconds of 600.
Project policy roleProfiles contains unsupported field "editor".
```

Because the Action reads policy from the base commit, a pull request that edits `.diffowl.json` is still reviewed under the base branch's rules. The edited policy takes effect only after it merges.
