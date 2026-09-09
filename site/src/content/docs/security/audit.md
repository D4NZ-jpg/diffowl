---
title: Security audit
description: Every input the Action accepts, every sink it can reach, and what holds between them.
---

Last full pass: 2026-09-07, release 0.3.1. This page is the checklist; the [trust model](../trust-model/) explains the design.

## Method

List every place untrusted data enters, every place the process can cause an effect, and check each path from one to the other. "Untrusted" here means anything a pull-request author, a commenter, a fork, or a model can influence. The workflow token and the credential store are treated as high-value secrets rather than inputs.

## Inputs

| Input                               | Who controls it                                                             | Where it goes                                                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Event payload (`GITHUB_EVENT_PATH`) | GitHub writes it; PR author controls titles, bodies, branch names inside it | Parsed with shape checks; only `repository.full_name`, PR number, base/head SHAs and repos, and author login are read           |
| `workflow_dispatch` inputs          | Anyone who can dispatch the workflow (write access)                         | Every value re-verified against the live pull request before use; SHAs must be full hex                                         |
| Comment bodies (`/diffowl ...`)     | Any commenter                                                               | Parsed by an anchored regex; command must be from the author or a writer; free text bounded to 4,000 characters                 |
| Pull-request diff and checkout      | PR author                                                                   | Read-only evidence; validation commands execute it on the runner under a scrubbed environment                                   |
| `.diffowl.json`                     | Base branch only                                                            | Never read from the head; a PR cannot change its own policy                                                                     |
| Model output                        | Provider, and indirectly whatever the model read                            | Structured output validated against a schema; becomes review text and evidence paths, never a command, path template, or method |
| Repository-file requests from roles | Model                                                                       | Path must be plain and relative, revision must be the verified head SHA                                                         |

## Sinks

| Sink                              | Guard                                                                                                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub REST                       | Transport bound to `GITHUB_REPOSITORY` and a role; allowlisted method + path shapes only; refused before the token is attached                                       |
| GitHub GraphQL                    | Three named operations, one per document                                                                                                                             |
| `git push`                        | Atomic, non-forcing, destinations under `refs/diffowl/state/` only; checked on the argv                                                                              |
| `git show`, `git diff`            | Object ids proven full hex; paths proven plain relative; `--` passed; no color or external diff drivers                                                              |
| Validation commands               | argv array from base-branch policy, never a shell; environment limited to `PATH`, `CI`, no-op git config; bounded output and timeout; process tree killed on timeout |
| Suggested-patch validation        | Docker with `--network none`, `--read-only`, `--cap-drop ALL`, memory and pid limits, non-root user, read-only bind of one file; symlinks refused                    |
| Role sandbox (Action)             | Virtual; no host filesystem or shell                                                                                                                                 |
| Role sandbox (CLI `--repository`) | Host sandbox with path restriction only; documented as unsafe for unread pull requests                                                                               |
| Filesystem                        | State directory created `0700`, files `0600`, written via temp file and rename; lock directories with owner records                                                  |
| Action outputs and job summary    | Appended to runner-provided paths; content is the typed outcome, bounded                                                                                             |
| Secrets                           | `GITHUB_TOKEN` and `DIFFOWL_CREDENTIAL_STORE_*` deleted from the environment before any role or command; held only in closures                                       |

## Findings from the last pass

Fixed in 0.3.0 and 0.3.1:

- The token's reach was bounded only by convention. Now enforced at the transport and on the push argv.
- Revisions and paths reached `git` unvalidated. A crafted `workflow_dispatch` input or a model-chosen path shaped like `--output=...` would have been parsed as an option. Now proven before the argv is built.
- Author context for finding commands was unbounded. Now cut at 4,000 characters.
- Transitive advisories in `undici`, `brace-expansion`, and `protobufjs` through the pinned `pi-coding-agent`. Overridden to a clean release; `npm audit` reports zero.
- Third-party actions were pinned to major tags. Now pinned to commit SHAs with version comments; Dependabot keeps them current.

Known and accepted:

- `contents: write` is wider than the state refs need. GitHub cannot scope a token to a ref prefix. `.github/ruleset-protect-branches-and-tags.json` is a ruleset that blocks every update to branches and tags except by repository admins; apply it with `gh api -X POST repos/{owner}/{repo}/rulesets --input .github/ruleset-protect-branches-and-tags.json`.
- Validation commands run the pull request's code on the runner. That is the point of them. The boundary is the job: checkout plus the Action, one secret, nothing else mounted.
- Anyone with write access can trigger `workflow_dispatch` directly, bypassing the router. The dispatched run still verifies the pull request against GitHub and requires a durable review-request event id that only the router records, so a direct dispatch without one produces `policy_skip`.
- The local CLI's `--repository` mode runs roles with the invoking user's shell. Not for untrusted pull requests.

## Reproduce

```sh
npm audit --omit=dev
npx vitest run tests/github-scope.test.ts tests/git-args.test.ts tests/v1-threat-suite.test.ts
```

The threat suite asserts every refusal above with no network call made.
