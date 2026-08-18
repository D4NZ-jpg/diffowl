---
title: Troubleshooting
description: Diagnose common setup, state, credential, validation, and publication failures.
---

Start with the workflow job summary and the typed `outcome` output. Do not infer success from the absence of comments.

## Configuration failure before review

Check that:

- `.diffowl.json` exists on the base revision;
- every active field is supported;
- all three role profiles are defined;
- limits stay within security ceilings;
- validation commands are argv arrays with valid timeouts;
- referenced credential profiles are supplied by the trusted adapter.

## No diff or incomplete history

The checkout must use the exact head SHA and full history:

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.event.pull_request.head.sha }}
    fetch-depth: 0
    persist-credentials: false
```

## Provider failure

Confirm that the secret expected by each provider exists in the canonical review workflow. Never add provider secrets to the comment router. Provider failure remains non-clean even if another role completed.

## Partial coverage on a fork or Dependabot pull request

This is expected. Untrusted pull requests cannot receive secrets, write tokens, privileged tools, validation execution, or publication. Diffowl reports the blocked coverage rather than pretending the review was complete.

## Durable-state failure

For GitHub-hosted runs, confirm `contents: write` and inspect guidance about dedicated `refs/diffowl/state/...` refs.

For self-hosted runs, set `self-hosted-state-directory` to a writable, durable, trusted path outside pull-request-controlled content.

## Findings exist but no review was published

Check:

- `GITHUB_TOKEN` is present;
- `pull-requests: write` is granted;
- the pull request still points to the exact reviewed head SHA;
- the `publication` output for `refused` or `incomplete` status.

Diffowl refuses stale-head publication.

## Validation did not run

Validation runs only when trust and adapter capabilities permit it. Built-in host execution is unavailable by default on self-hosted and unknown runners. Suggested-patch validation additionally requires the digest-pinned image to be present locally and a matching policy rule.

## A command was ignored

Finding commands must be exact, top-level, and single-line. Remove block quotes, code fences, leading prose, and unsupported trailing context. Commands that require a reason or context must include one.

## Local CLI cannot publish

This is intentional. `--publish` records the request, but `local_cli` trust always returns publication as `not_attempted`.
