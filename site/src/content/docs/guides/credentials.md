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

## GitHub Action: shared credential store (subscriptions)

An API key is a static secret. A subscription login is an OAuth token pair that expires and must be refreshed, and two runners refreshing at once would clobber each other. For that case the Action can take its `default` profile from a shared, lockable store backed by Postgres, using [`@runcell/postgres-credentials`](https://www.npmjs.com/package/@runcell/postgres-credentials). Any Postgres works, including Supabase, Neon, or RDS through a pooler in transaction mode.

Set three variables instead of provider keys:

```yaml
- uses: D4NZ-jpg/diffowl@v0
  env:
    GITHUB_TOKEN: ${{ github.token }}
    DIFFOWL_CREDENTIAL_STORE_URL: ${{ secrets.DIFFOWL_CREDENTIAL_STORE_URL }}
    DIFFOWL_CREDENTIAL_STORE_KEY: diffowl-default
    DIFFOWL_CREDENTIAL_STORE_SECRET: ${{ secrets.DIFFOWL_CREDENTIAL_STORE_SECRET }}
```

| Variable                          | Meaning                                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `DIFFOWL_CREDENTIAL_STORE_URL`    | Postgres connection string. Use a role with `SELECT`, `INSERT`, `UPDATE` on the table and nothing else. |
| `DIFFOWL_CREDENTIAL_STORE_KEY`    | Row key holding the provider auth blob. Default `diffowl-default`.                                      |
| `DIFFOWL_CREDENTIAL_STORE_SECRET` | Optional. Encrypts blobs at rest with AES-256-GCM. Losing it loses the stored credentials.              |

All three are consumed and deleted from the process environment when the Action starts, before any role sandbox or validation command exists. The row is read and refreshed inside a single transaction under `SELECT ... FOR UPDATE`, so concurrent runs queue rather than overwrite a rotated refresh token.

One-time setup, from your own machine:

```bash
# 1. Create the table with a role that has DDL (the runner role should not).
npx review-owl credentials sql | psql "$ADMIN_DATABASE_URL"

# 2. Copy your local provider login into the row. Only the named providers are
#    sent; nothing is printed. Reads ~/.pi/agent/auth.json by default.
export DIFFOWL_CREDENTIAL_STORE_URL="postgres://..."
export DIFFOWL_CREDENTIAL_STORE_SECRET="..."   # same value as the repository secret
npx review-owl credentials push --provider anthropic

# 3. Check what the row holds, without secrets.
npx review-owl credentials status
```

The runner's database role should be scoped to that one table. The URL is a secret with the same blast radius as the login it protects: treat it like the provider key it replaces. Using a personal subscription from CI is subject to your provider's terms.

## Local CLI: local credentials

The CLI's default profile is `local`, which resolves through local RunCell credential configuration. Supported sources include provider environment variables and stored Codex or Claude logins on the developer machine.

Local credentials, tools, and validation are classified `local_user_authorized`. They authorize local work only; they never grant CI trust or publishing.

## Embedding: explicit profiles

When calling `runReview` directly, supply the profile map yourself:

```ts
import { runReview, type DiffowlCredentials } from "review-owl";

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
