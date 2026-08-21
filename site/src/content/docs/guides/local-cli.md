---
title: Local CLI
description: Reproduce and inspect the Review OWL engine locally.
---

The local CLI runs the same review engine contract used by the GitHub Action. Use it for reproduction, debugging, inspection, and evaluation. Do not treat it as CI trust evidence.

## Requirements

- Node.js 22 or newer
- a local clone of Diffowl
- local provider credentials supported by RunCell

## Build and run

```bash
npm install
npm run build
node dist/cli.js review \
  --input tests/fixtures/pull-request.json \
  --policy tests/fixtures/project-policy.json \
  --state-directory .diffowl-state
```

## Pull-request input

```json
{
  "repository": "example/review-target",
  "number": 42,
  "baseSha": "1111111111111111111111111111111111111111",
  "headSha": "2222222222222222222222222222222222222222",
  "diff": "diff --git ..."
}
```

## Options

```text
Usage: diffowl review --input <pull-request.json> --policy <local-policy.json> [options]

Options:
  --state-directory <path>  Persist and inspect local run records and Finding ledger state.
  --dry-run                 Run locally without publishing. This is the default.
  --publish                 Request publishing mode; local trust still denies GitHub publication.
```

The report is JSON and includes the typed outcome, material findings, advisory suggestions, verification state, diagnostics, and optional persisted run and ledger data. The [CLI reference](../../reference/cli/) documents every field, the input schema, and exit codes; [Debugging failed runs](../debugging-runs/) shows how to reproduce an Action run locally.

## Local persistence

Reusing `--state-directory` reconciles finding lifecycle across runs without a hosted database. Diffowl permission-restricts the directory, but you remain responsible for keeping it private, trusted, and backed up according to your audit requirements.

## Credentials and trust

The default CLI credential profile uses local RunCell credentials, including supported Codex or Claude logins. Local credentials, tools, and validation are marked `local_user_authorized`.

:::caution[Publishing remains disabled]
`--publish` records that publication was requested, but the `local_cli` trust class still returns publication as `not_attempted`.
:::
