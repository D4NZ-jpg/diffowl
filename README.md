# Diffowl

Diffowl is a self-hostable pull-request review system. Review OWL runs an evidence-backed first pass so a person can focus on product judgment and material findings.

> [!NOTE]
> This repository is under active V1 development. The GitHub Action and local CLI use the same Review engine and return the same typed outcome contract.

## GitHub Action

The Action classifies the pull-request context before it reads repository content. It requires a checkout with full history so it can read the pull-request diff.

```yaml
name: Review OWL

on:
  pull_request:
    types: [opened, synchronize, reopened]
  workflow_dispatch:
    inputs:
      repository: { required: true, type: string }
      pull-request-number: { required: true, type: string }
      base-sha: { required: true, type: string }
      head-sha: { required: true, type: string }
      review-request-event-id: { required: true, type: string }
      command-work-type: { required: false, type: string }
      finding-fingerprint: { required: false, type: string }
      finding-context: { required: false, type: string }
      finding-root-comment-id: { required: false, type: string }

concurrency:
  group: review-owl-${{ inputs.pull-request-number || github.event.pull_request.number }}
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
          ref: ${{ inputs.head-sha || github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - id: review-owl
        uses: D4NZ-jpg/diffowl@main
        with:
          repository: ${{ inputs.repository }}
          pull-request-number: ${{ inputs.pull-request-number }}
          base-sha: ${{ inputs.base-sha }}
          head-sha: ${{ inputs.head-sha }}
          review-request-event-id: ${{ inputs.review-request-event-id }}
          command-work-type: ${{ inputs.command-work-type }}
          finding-fingerprint: ${{ inputs.finding-fingerprint }}
          finding-context: ${{ inputs.finding-context }}
          finding-root-comment-id: ${{ inputs.finding-root-comment-id }}
        env:
          GITHUB_TOKEN: ${{ github.token }}
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
```

To accept `/diffowl review` and inline Finding commands, also install the trusted [`issue_comment` and `pull_request_review_comment` router workflow](examples/representative-repository/.github/workflows/review-request.yml). It checks out only the default branch, carries no provider secrets, authenticates the actor against the latest same-repository pull-request head, resolves nested replies to the stable root Finding marker, records each command event before effects, and dispatches this canonical workflow at the default-branch ref with the verified revision as explicit inputs. `/diffowl recheck` reruns deterministic Verification and `/diffowl reassess <context>` supplies product or technical context without copying a Finding identity. A command on the currently reviewed head runs bounded Finding discussion work without a full Review; a newer head uses the same canonical full Review path. Accepted and coalesced requests receive an eyes reaction. Refused requests receive one short reply. Queued progress appears on the trusted default-branch Actions run because GitHub binds a `workflow_dispatch` check to its dispatch ref; Diffowl does not create a second PR-head custom check. `/diffowl rerun` is a deprecated alias for the same path.

The Action's `default` credential profile uses RunCell's `env` credential mode. Provider SDKs read their normal variables from GitHub Secrets. Embedded deployments may instead supply any RunCell `Credentials` configuration, including an explicit agent directory or shared `CredentialStore` for refreshable OAuth credentials.

On GitHub-hosted trusted same-repository pull-request runs, Review OWL stores the canonical Finding ledger and versioned Review run records in dedicated base-repository Git refs under `refs/diffowl/state/...`. Checkout credentials remain disabled; the Action supplies its token only to the bounded Git subprocesses that read or advance those refs, so validation commands cannot inherit repository credentials from the workspace. The Action advances refs without force; on a concurrent writer it rereads state, recomputes the persistence transition, and retries once. This path requires `contents: write`. Missing permissions, corrupt state, deleted refs, or apparent rewrites produce a configuration failure with guidance instead of falling back to comments, checks, artifacts, caches, variables, or ephemeral workspace files.

`state-directory` remains the filesystem persistence option for the local CLI and explicit self-hosted execution. The path is optional, but when configured it must be a trusted directory that survives separate Action process invocations. For persistence across workflow runs, self-hosted deployments must mount or otherwise preserve this directory. Do not place the state directory under pull-request-controlled content or publish it as a public artifact. The Action outputs the typed `outcome`, plus `run-id` and safe `run-metadata` when persistence succeeds. A corrupt or unwritable configured store produces a bounded non-clean failure rather than silently returning a clean result.

The Action reads `.diffowl.json` from the pull request's base commit. It never reads policy from the pull-request head or synthetic merge commit, so a pull request cannot weaken its own review policy. The `outcome` output contains the typed Review outcome as JSON, including its Trust class and effective capabilities.

Same-repository pull requests may use only the trusted credential profiles referenced by base-branch role profiles. The repository policy names profiles but does not contain secrets or grant secret-store access. The Action maps `default` to RunCell environment credentials by default. They are also eligible for configured validation commands only within the externally isolated GitHub job and the policy timeout. Fork and Dependabot pull requests are untrusted: validation commands, secrets, write tokens, privileged tools, and publishing are denied. They receive a `partial_coverage` outcome while the tracer can perform only static review. Unsupported or unsafe event contexts receive a `policy_skip`; invalid, missing, over-budget, or security-weakening policy receives a `configuration_failure`. None of these cases can appear clean.

The engine returns data only; GitHub publication remains the responsibility of the Action adapter. When `GITHUB_TOKEN` is configured, the adapter verifies the pull request's exact current head before publishing one non-approving pull-request review only when actionable Findings exist. Changed-line Findings become inline review comments, and unanchored Findings appear in the review body. The existing workflow check remains the sole merge-gating surface; Diffowl does not create a duplicate custom check or current-summary comment. A successful workflow check means ready for targeted human review. A failed check means return to the author when Findings are actionable, or that no defensible readiness result exists. A skipped check means a deterministic Project-policy exclusion. A cancelled check means a newer revision superseded the run.

The Action writes a compact job summary and returns the Publication result with confirmed effects separately through the `publication` output, so publication delivery never enters Review engine semantics. The summary identifies Review readiness, Review outcome, the reviewed revision, Finding and Verification counts, coverage limits, Publication result, and links to the pull-request review and workflow logs when available. Publication is `complete`, `not_attempted`, `refused`, or `incomplete`. Confirmed partial effects remain in the Publication result for reconciliation, and a refused or incomplete required publication fails the Action without replacing the Review outcome. The publisher uses the separate SHA-bound, bounded, data-only capability class and cannot execute pull-request code. Omit `GITHUB_TOKEN` to record publication as `not_attempted`.

Review OWL finding threads include an engine-owned Finding identity marker and list the minimal audited commands authors can use in replies: `/diffowl accept`, `/diffowl rebut <context>`, `/diffowl suppress <reason>`, `/diffowl ignore <reason>`, `/diffowl resolved`, `/diffowl recheck`, `/diffowl explain`, and `/diffowl reassess <context>`. GitHub-hosted commands are event-driven rather than discovered by rescanning historical comments. Exact top-level commands are required, so quoted, fenced, and multiline command-looking text is ignored. The persisted Finding ledger keeps each recognized event with actor, command, timestamp, source, and body; the GitHub projection replies in the original discussion and resolves or reopens the thread according to its visible disposition.

Completed reviews return either `clean` or `findings` with `coverage: "completed_permitted"`. `clean` means the completed permitted review found no material findings; it is not proof of correctness. Material findings and non-blocking `advisorySuggestions` use separate fields. Each material finding includes its location, impact, evidence objects, lifecycle state, and verification state.

Non-clean runs remain explicit through `findings`, `partial_coverage`, `policy_skip`, `unsupported_change`, `budget_limit`, `resource_limit`, `timeout`, `provider_failure`, `configuration_failure`, `internal_failure`, or `abstention`. These outcomes cannot be serialized as clean reviews.

A complete example is in [`examples/representative-repository`](examples/representative-repository).

## Local CLI

Use Node.js 22 or newer.

```bash
npm install
npm run build
node dist/cli.js review \
  --input tests/fixtures/pull-request.json \
  --policy tests/fixtures/project-policy.json \
  --state-directory .diffowl-state
```

The optional `--state-directory` stores per-repository, per-pull-request ledger and run-record data on the local filesystem. Reusing the same directory across invocations reconciles Finding lifecycle without any hosted database. The directory is permission-restricted by Diffowl and should remain private, trusted, and backed up according to the team's audit requirements. Omitting it preserves stateless CLI behavior.

The CLI emits a local inspection report as JSON. The report includes the typed Review outcome, material Findings, advisory suggestions, verification state, diagnostics, and, when `--state-directory` is configured, the persisted run record and current Finding ledger. `--dry-run` is the default. `--publish` records an explicit publishing request in the local report, but local CLI publication remains `not_attempted`.

The CLI reads the policy path supplied by the local user and maps `default` to RunCell's local credentials, reusing supported Codex or Claude logins on the user's machine. Its outcome uses the `local_cli` Trust class and marks local credentials, tools, and validation as `local_user_authorized`. Publishing remains denied by trust class and `not_attempted` as a Publication result. Local policy execution is not CI trust evidence.

## Synthetic evaluation report cards

Embedders can import `evaluateSyntheticCorpus` to turn repeatable synthetic observations into a release report card. A corpus lists material-finding cases and clean controls, each with an expected typed outcome and expected material Findings. Observations attach the Review outcome plus review-ready latency, token, cost, and runtime diagnostics when available. The report card records expected material Findings found and missed, unexpected material Findings and advisory suggestions on clean controls, typed outcome categories (`skip`, `partial`, `limit`, `timeout`, `provider`, `configuration`, `internal`, and related outcomes), and per-case diagnostics. See [`examples/synthetic-evaluation-corpus.json`](examples/synthetic-evaluation-corpus.json) for the stable corpus shape.

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
  "verification": {
    "validationCommands": [{ "argv": ["npm", "test"], "timeoutSeconds": 120 }]
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

Policy fields are closed: unsupported active fields fail configuration instead of being ignored. `reviewRequests.cooldownSeconds` is optional, defaults to 300 seconds, and cannot be lower than the non-overridable 60-second security minimum. Validation commands are trusted base-policy argv arrays, never shell strings. A policy may configure at most 10 commands, each with a timeout no greater than 600 seconds or the complete review timeout; captured stdout and stderr share a 64 KiB bound. On GitHub-hosted runners, the Action executes configured commands without a shell through a credential-free host adapter with abort support, relying on the ephemeral GitHub-hosted job as the isolation boundary. On self-hosted or unknown runners, built-in host execution is unavailable by default; embeddings must inject an isolated `verificationAdapter` to enable validation. The adapter itself does not enforce OS isolation. Local CLI execution remains explicitly user-authorized host execution. Process groups are terminated on timeout or abort where the platform supports them.

Every policy defines reviewer, challenger, and verifier profiles with a provider, model, and credential-profile name. The trusted Action or CLI adapter supplies those profiles as RunCell `Credentials`; repository policy and review-agent input contain no raw secrets.

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

Run the complete CI check locally with `npm run check`. Oxlint enforces correctness, suspicious-code, performance, and cyclomatic-complexity rules. Each function is limited to a cyclomatic complexity of 10 and 60 non-blank, non-comment lines. Each file is limited to 300 non-blank, non-comment lines. Jscpd enforces zero detected duplication across `src`, `tests`, and `scripts` for clones of at least 5 lines and 50 tokens. Oxfmt provides deterministic formatting, and `npm run format:check` verifies it without changing files.
