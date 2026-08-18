---
title: Quick start
description: Add Diffowl policy, provider credentials, and a pull-request workflow.
---

You need:

- a GitHub repository;
- permission to add workflows and repository secrets;
- provider credentials for the configured role profiles;
- Node.js 24 on the Action runner, supplied by Diffowl's bundled Action runtime.

## 1. Add project policy

Create `.diffowl.json` on the default branch:

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
    "validationCommands": []
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

Diffowl reads this file from the pull request's base commit. A pull request cannot weaken its own review policy.

## 2. Add provider secrets

Add the variables required by your role profiles under **Settings → Secrets and variables → Actions**. The example policy expects:

- `OPENAI_API_KEY`
- `ANTHROPIC_API_KEY`

Repository policy names credential profiles but never contains raw secrets.

## 3. Add the workflow

Create `.github/workflows/review-owl.yml`:

```yaml title=".github/workflows/review-owl.yml"
name: Review OWL

on:
  pull_request:
    types: [opened, synchronize, reopened]

concurrency:
  group: review-owl-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: write
  pull-requests: write
  issues: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: D4NZ-jpg/diffowl@main
        env:
          GITHUB_TOKEN: ${{ github.token }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

`fetch-depth: 0` is required so Diffowl can read the exact pull-request diff. Checkout credentials stay disabled; bounded persistence operations receive the token directly.

## 4. Open a pull request

The workflow runs when the pull request opens, receives commits, or reopens. Its job summary reports:

- review readiness and typed outcome;
- reviewed revision;
- finding and verification counts;
- coverage limitations;
- publication status and links.

## Next steps

- Add [manual review and finding commands](../github-action/#review-and-finding-commands).
- Configure [validation commands and scope](../../configuration/project-policy/).
- Learn why [fork and Dependabot reviews have reduced capabilities](../../security/trust-model/).
