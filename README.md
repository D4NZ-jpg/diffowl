# Diffowl

Diffowl is a self-hostable pull-request review system. Review OWL runs an evidence-backed first pass so a person can focus on product judgment and material findings.

> [!NOTE]
> This repository currently contains the tracer path from issue #17. It proves that the GitHub Action and local CLI use the same Review engine. The tracer reports `partial_coverage` because review analysis is not implemented yet.

## GitHub Action

The Action classifies the pull-request context before it reads repository content. It requires a checkout with full history so it can read the pull-request diff.

```yaml
name: Review OWL

on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - id: review-owl
        uses: D4NZ-jpg/diffowl@main
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

The Action's `default` credential profile uses RunCell's `env` credential mode. Provider SDKs read their normal variables from GitHub Secrets. Embedded deployments may instead supply any RunCell `Credentials` configuration, including an explicit agent directory or shared `CredentialStore` for refreshable OAuth credentials.

The Action reads `.diffowl.json` from the pull request's base commit. It never reads policy from the pull-request head or synthetic merge commit, so a pull request cannot weaken its own review policy. The `outcome` output contains the typed Review outcome as JSON, including its Trust class and effective capabilities.

Same-repository pull requests may use only the trusted credential profiles referenced by base-branch role profiles. The repository policy names profiles but does not contain secrets or grant secret-store access. The Action maps `default` to RunCell environment credentials by default. They are also eligible for configured validation commands only in a sandbox and within the policy timeout. Fork and Dependabot pull requests are untrusted: validation commands, secrets, write tokens, privileged tools, and publishing are denied. They receive a `partial_coverage` outcome while the tracer can perform only static review. Unsupported or unsafe event contexts receive a `policy_skip`; invalid, missing, over-budget, or security-weakening policy receives a `configuration_failure`. None of these cases can appear clean.

The engine returns data only; GitHub publication remains the responsibility of an adapter. A future privileged publisher must use the separate SHA-bound, data-only capability class and cannot execute pull-request code.

A complete example is in [`examples/representative-repository`](examples/representative-repository).

## Local CLI

Use Node.js 22 or newer.

```bash
npm install
npm run build
node dist/cli.js review \
  --input tests/fixtures/pull-request.json \
  --policy tests/fixtures/project-policy.json
```

The CLI reads the policy path supplied by the local user and maps `default` to RunCell's local credentials, reusing supported Codex or Claude logins on the user's machine. Its outcome uses the `local_cli` Trust class and marks local credentials, tools, and validation as `local_user_authorized`. Publishing remains denied. Local policy execution is not CI trust evidence.

The pull-request input file has this shape:

```json
{
  "repository": "example/review-target",
  "number": 42,
  "baseSha": "1111111111111111111111111111111111111111",
  "headSha": "2222222222222222222222222222222222222222",
  "diff": "diff --git ..."
}
```

## Project policy

Project policy is JSON:

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

Policy fields are closed: unsupported active fields fail configuration instead of being ignored. Every policy defines reviewer, challenger, and verifier profiles with a provider, model, and credential-profile name. The trusted Action or CLI adapter supplies those profiles as RunCell `Credentials`; repository policy and review-agent input contain no raw secrets.

The default Action profile uses environment variables populated from GitHub Secrets. The default CLI profile uses local Codex, Claude, or other supported Pi credentials. Programmatic deployments can supply RunCell `env`, `local`, `agentDir`, or `shared` credentials. Diffowl intentionally excludes RunCell’s in-memory `apiKeys` mode so raw keys cannot enter role-execution requests. A shared `CredentialStore` can persist and rotate OAuth credentials in a team-controlled database, KV store, vault, or secret manager. Diffowl does not need a hosted provider or permission to modify GitHub Secrets. Missing profile references fail configuration without exposing secret values.

`reviewTimeoutSeconds` is the hard, user-facing limit for the complete provider-backed review. It must not exceed 3600, and `maxFindings` must not exceed 100. These ceilings cannot be overridden by repository or local policy. Timeout, provider failure, and provider-reported budget limits return distinct non-clean typed outcomes.

## Development

```bash
npm run format
npm run lint
npm run typecheck
npm test
npm run build
```

Run the complete CI check locally with `npm run check`. Oxlint enforces correctness, suspicious-code, performance, and cyclomatic-complexity rules. Each function is limited to a cyclomatic complexity of 10 and 60 non-blank, non-comment lines. Each file is limited to 300 non-blank, non-comment lines. Oxfmt provides deterministic formatting, and `npm run format:check` verifies it without changing files.
