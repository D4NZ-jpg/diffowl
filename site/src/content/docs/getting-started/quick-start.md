---
title: Quick start
description: Install Review OWL on a repository as a request-only reviewer with a shared credential store.
---

This installs Diffowl so that a collaborator comments `/diffowl review` on a pull request and gets an evidence-backed review as a check and a review comment. Nothing runs automatically on every push; you opt in per pull request. Credentials live in a Postgres row, not in provider API keys, so a subscription login can be used.

You need:

- a GitHub repository where you can add workflows and secrets;
- a Postgres you can reach from GitHub-hosted runners (Supabase, Neon, RDS, any pooler in transaction mode), or provider API keys if you prefer [environment credentials](../../guides/credentials/#github-action-environment-credentials);
- Node.js 22 or newer on your machine for the one-time credential setup.

Pin the Action to a release tag. `@v0` follows the latest 0.x release.

## 1. Add project policy

Create `.diffowl.json` on the default branch. Diffowl reads it from the pull request's base commit, so a pull request cannot weaken its own review.

```json title=".diffowl.json"
{
  "version": 1,
  "scope": {
    "includePaths": ["src/**", "tests/**"],
    "excludePaths": ["dist/**"]
  },
  "limits": {
    "reviewTimeoutSeconds": 1800,
    "maxFindings": 25
  },
  "verification": {
    "validationCommands": [
      { "argv": ["npm", "ci", "--ignore-scripts"], "timeoutSeconds": 300 },
      { "argv": ["npm", "test"], "timeoutSeconds": 600 }
    ]
  },
  "reviewRequests": {
    "cooldownSeconds": 120
  },
  "presentation": {
    "advisories": "summary"
  },
  "roleProfiles": {
    "reviewer": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "credentialProfile": "default"
    },
    "challenger": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "credentialProfile": "default"
    },
    "verifier": {
      "provider": "anthropic",
      "model": "claude-sonnet-4-6",
      "credentialProfile": "default"
    }
  }
}
```

Notes on the values:

- `reviewTimeoutSeconds`: with a repository checkout the three roles read code and take 2 to 10 minutes on a typical pull request, more on large diffs. 1800 leaves headroom; the ceiling is 3600.
- `validationCommands` run the pull request's own code on the runner under a scrubbed environment. Put dependency installation here rather than in a workflow step, and use `--ignore-scripts` so lifecycle scripts do not run outside that environment.
- `presentation.advisories`: `summary` folds non-blocking suggestions into one collapsed block at the end of the review. Switch to `off` or `inline` later once you have seen how your team uses them.
- If your team works from personal forks of a private repository, add `"trust": { "collaboratorForks": true }`. See the [trust model](../../security/trust-model/) before enabling it on a public repository.

## 2. Set up the credential store

Run this once, from your own machine, with a Postgres role that can create tables:

```bash
npx review-owl credentials sql | psql "$ADMIN_DATABASE_URL"
```

Create a role for the runner that can read and update that table and nothing else:

```sql
CREATE ROLE diffowl_runner LOGIN PASSWORD '<generate one>';
GRANT SELECT, INSERT, UPDATE ON runcell_credentials TO diffowl_runner;
```

Copy your provider login into the row. Only the named providers are read from `~/.pi/agent/auth.json`; nothing is printed.

```bash
export DIFFOWL_CREDENTIAL_STORE_URL="postgresql://diffowl_runner:...@<host>:6543/postgres"
export DIFFOWL_CREDENTIAL_STORE_SECRET="$(openssl rand -base64 32)"
npx review-owl credentials push --provider anthropic
npx review-owl credentials status
```

Use the transaction-mode pooler connection string (port 6543 on Supabase). Keep the secret somewhere durable: it encrypts the row and cannot be recovered.

## 3. Add repository secrets

```bash
gh secret set DIFFOWL_CREDENTIAL_STORE_URL --body "$DIFFOWL_CREDENTIAL_STORE_URL"
gh secret set DIFFOWL_CREDENTIAL_STORE_SECRET --body "$DIFFOWL_CREDENTIAL_STORE_SECRET"
```

The Action consumes both before any role or validation command can run. Repository policy names a credential profile and never contains secrets.

## 4. Add the workflows

Two files. The router runs on comments with no provider secrets, verifies the commenter and the pull-request head, and dispatches the review. The review workflow only accepts that dispatch.

```yaml title=".github/workflows/review-request.yml"
name: Review OWL request

on:
  issue_comment:
    types: [created]
  pull_request_review_comment:
    types: [created]

permissions:
  actions: write
  contents: write
  pull-requests: write
  issues: write

jobs:
  route:
    if: ${{ startsWith(github.event.comment.body, '/diffowl ') && (github.event_name == 'pull_request_review_comment' || github.event.issue.pull_request) }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.repository.default_branch }}
          fetch-depth: 0
          persist-credentials: false
      - uses: D4NZ-jpg/diffowl/review-request@v0
        with:
          workflow: review-owl.yml
        env:
          GITHUB_TOKEN: ${{ github.token }}
```

```yaml title=".github/workflows/review-owl.yml"
name: Review OWL

on:
  workflow_dispatch:
    inputs:
      repository:
        required: true
        type: string
      pull-request-number:
        required: true
        type: string
      base-sha:
        required: true
        type: string
      head-sha:
        required: true
        type: string
      head-repository:
        required: false
        type: string
      review-request-event-id:
        required: true
        type: string
      command-work-type:
        required: false
        type: string
      finding-fingerprint:
        required: false
        type: string
      finding-context:
        required: false
        type: string
      finding-root-comment-id:
        required: false
        type: string

concurrency:
  group: review-owl-${{ inputs.pull-request-number }}
  cancel-in-progress: true

permissions:
  contents: write
  pull-requests: write
  issues: read

jobs:
  review:
    runs-on: ubuntu-latest
    timeout-minutes: 40
    steps:
      - uses: actions/checkout@v4
        with:
          repository: ${{ inputs.head-repository || github.repository }}
          ref: ${{ inputs.head-sha }}
          fetch-depth: 0
          persist-credentials: false
      # No other steps. Anything that runs the pull request's own scripts
      # belongs in .diffowl.json validationCommands. This job carries the
      # credential-store secrets and nothing else.
      - uses: D4NZ-jpg/diffowl@v0
        with:
          repository: ${{ inputs.repository }}
          pull-request-number: ${{ inputs.pull-request-number }}
          base-sha: ${{ inputs.base-sha }}
          head-sha: ${{ inputs.head-sha }}
          head-repository: ${{ inputs.head-repository }}
          review-request-event-id: ${{ inputs.review-request-event-id }}
          command-work-type: ${{ inputs.command-work-type }}
          finding-fingerprint: ${{ inputs.finding-fingerprint }}
          finding-context: ${{ inputs.finding-context }}
          finding-root-comment-id: ${{ inputs.finding-root-comment-id }}
        env:
          GITHUB_TOKEN: ${{ github.token }}
          DIFFOWL_CREDENTIAL_STORE_URL: ${{ secrets.DIFFOWL_CREDENTIAL_STORE_URL }}
          DIFFOWL_CREDENTIAL_STORE_KEY: diffowl-default
          DIFFOWL_CREDENTIAL_STORE_SECRET: ${{ secrets.DIFFOWL_CREDENTIAL_STORE_SECRET }}
```

To review every pull request automatically instead, add a `pull_request` trigger to `review-owl.yml`; the [GitHub Action](../github-action/) page shows that variant. Fork pull requests get no secrets from GitHub on that trigger, so they are reviewed statically or not at all.

## 5. Request a review

Open a pull request and comment:

```
/diffowl review
```

The router reacts with 👀 and dispatches the review at the verified head. The result arrives as a check run on the pull request and, when there are findings or suggestions, one non-approving review. The job summary reports readiness, the reviewed revision, finding and verification counts, coverage limits, and links.

Reply to a finding thread with `/diffowl accept`, `/diffowl rebut`, `/diffowl resolve`, or `/diffowl suppress` to move it through its lifecycle; see [finding discussions](../../guides/finding-discussions/).

## Next steps

- Read the [trust model](../../security/trust-model/) for what runs where, and what a fork or Dependabot pull request can and cannot do.
- Tune [scope, validation, and presentation](../../configuration/project-policy/).
- Run the same engine [locally](../../guides/local-cli/) to reproduce a review.
