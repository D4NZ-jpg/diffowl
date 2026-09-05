---
title: Credentials and providers
description: How role profiles resolve to provider credentials in the Action, the CLI, and embeddings.
---

Diffowl is bring-your-own-key. Role profiles in `.diffowl.json` name a provider, a model, and a **credential profile**; the adapter resolves that profile to actual credentials at runtime. Policy never contains raw secrets.

```json title=".diffowl.json (excerpt)"
{
  "roleProfiles": {
    "reviewer": { "provider": "openai", "model": "gpt-5", "credentialProfile": "default" },
    "challenger": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "credentialProfile": "default"
    },
    "verifier": { "provider": "openai", "model": "gpt-5-mini", "credentialProfile": "default" }
  }
}
```

If a role names a credential profile the adapter cannot resolve, the run fails closed with a `configuration_failure` naming the missing profile.

## GitHub Action: environment credentials

The Action resolves the `default` profile from the workflow environment. Pass provider keys as `env` entries backed by repository secrets:

```yaml
- uses: D4NZ-jpg/diffowl@main
  env:
    GITHUB_TOKEN: ${{ github.token }}
    OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

Add whichever variables your configured providers require. `GITHUB_TOKEN` is consumed by the adapter for GitHub API work and removed from the environment before provider execution.

## Local CLI: local credentials

The CLI's default profile is `local`, which resolves through local RunCell credential configuration. Supported sources include provider environment variables and stored Codex or Claude logins on the developer machine.

Local credentials, tools, and validation are classified `local_user_authorized`. They authorize local work only; they never grant CI trust or publishing.

## Embedding: explicit profiles

When calling `runReview` directly, supply the profile map yourself:

```ts
import { runReview, type DiffowlCredentials } from "diffowl";

const credentialProfiles: Record<string, DiffowlCredentials> = {
  default: { type: "env" },
  "review-bot": { type: "agentDir", path: "/etc/diffowl/agent" },
};
```

Credential values are one of:

| Value                            | Meaning                                                   |
| -------------------------------- | --------------------------------------------------------- |
| `"local"` or `{ type: "local" }` | Local RunCell credential resolution (developer machines). |
| `{ type: "env" }`                | Resolve from process environment variables.               |
| `{ type: "agentDir", path }`     | Resolve from a RunCell agent directory on disk.           |

See [Embedding the engine](../../integration/library/) for the full options object.

## Trust classes and secret access

Credential access is gated by trust classification before any risky work starts:

| Trust class                      | Secrets                   | Validation commands   | Publishing           |
| -------------------------------- | ------------------------- | --------------------- | -------------------- |
| `trusted_same_repo_pull_request` | provider credentials only | sandboxed             | denied (engine side) |
| `untrusted_pull_request`         | denied                    | denied                | denied               |
| `local_cli`                      | local user authorized     | local user authorized | denied               |
| `privileged_publisher`           | publisher token only      | denied                | SHA-bound, data only |
| `unsafe_or_unsupported`          | denied                    | denied                | denied               |

Fork and Dependabot pull requests never see provider secrets, write tokens, or privileged tools. Keep provider secrets out of any workflow that can be triggered by untrusted content; the [trusted request router](../durable-state/#the-trusted-request-router) exists exactly for this.

## Rotation and hygiene

- Scope provider keys to the repository, not the organization, unless you have a reason.
- Rotate keys through GitHub secret updates; no Diffowl state stores credential material.
- Run records store safe provider and model metadata only, never keys or tokens.
