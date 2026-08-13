# Diffowl

Diffowl is a self-hostable pull-request review system. Review OWL runs an evidence-backed first pass so a person can focus on product judgment and material findings.

> [!NOTE]
> This repository currently contains the tracer path from issue #17. It proves that the GitHub Action and local CLI use the same Review engine. The tracer reports `partial_coverage` because review analysis is not implemented yet.

## GitHub Action

The Action supports same-repository pull requests and requires a checkout with full history so it can read the pull-request diff.

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
```

The `outcome` output contains the typed Review outcome as JSON. The engine returns data only; GitHub publication remains the responsibility of an adapter.

A complete example is in [`examples/representative-repository`](examples/representative-repository).

## Local CLI

Use Node.js 20 or newer.

```bash
npm install
npm run build
node dist/cli.js review --input tests/fixtures/pull-request.json
```

The input file has this shape:

```json
{
  "repository": "example/review-target",
  "number": 42,
  "baseSha": "1111111111111111111111111111111111111111",
  "headSha": "2222222222222222222222222222222222222222",
  "diff": "diff --git ..."
}
```

## Development

```bash
npm test
npm run typecheck
npm run build
```
