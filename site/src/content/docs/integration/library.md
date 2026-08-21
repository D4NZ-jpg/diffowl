---
title: Embedding the engine
description: Call runReview directly, swap adapters, and consume typed outcomes from your own CI.
---

The GitHub Action and the local CLI are both thin adapters around one exported engine function. Anything they can do, an embedding can do: run reviews from another CI system, a bot, a batch evaluator, or a test harness.

The package entry point is `src/review-engine.ts`, exported as the `diffowl` module root.

```ts
import { classifyTrust, runReview, type ReviewOutcome } from "diffowl";
```

## Minimal embedding

```ts
import { readFile } from "node:fs/promises";
import { classifyTrust, runReview } from "diffowl";

const outcome = await runReview(
  {
    repository: "owner/name",
    number: 42,
    baseSha: "<base-sha>",
    headSha: "<head-sha>",
    diff: await readFile("pr.diff", "utf8"),
    trust: classifyTrust({ type: "local_cli" }),
    policy: {
      source: { type: "local_invocation", path: ".diffowl.json" },
      contents: await readFile(".diffowl.json", "utf8"),
    },
  },
  {
    credentialProfiles: { default: { type: "env" } },
  },
);

if (outcome.type === "findings") {
  for (const finding of outcome.materialFindings) {
    console.log(finding.location.path, finding.summary);
  }
}
```

`runReview` never throws for review-level problems; it returns a typed [outcome](../../reference/outcomes/). Treat only `clean` and `findings` (both with `coverage: "completed_permitted"`) as completed reviews.

## `PullRequestInput`

| Field        | Type                  | Notes                                                       |
| ------------ | --------------------- | ----------------------------------------------------------- |
| `repository` | `string`              | `owner/name` form.                                          |
| `number`     | `number`              | Pull-request number.                                        |
| `baseSha`    | `string`              | Base revision.                                              |
| `headSha`    | `string`              | Head revision under review.                                 |
| `diff`       | `string`              | Unified diff.                                               |
| `trust`      | `TrustClassification` | Produce with `classifyTrust`; never construct permissive capabilities by hand. |
| `policy`     | `ProjectPolicyInput`  | `source` plus the raw file `contents`; the engine parses and validates. |

### Trust classification

`classifyTrust` maps a context to a capability set:

```ts
classifyTrust({ type: "local_cli" });
classifyTrust({
  type: "github_pull_request",
  repository: "owner/name",
  headRepository: "owner/name",
  actor: "octocat",
});
```

Fork and Dependabot contexts get denied capabilities automatically; the engine then returns `partial_coverage` instead of executing risky work. If your host system has its own trust model, still express it through `classifyTrust` inputs so capability enforcement stays in one place.

## `ReviewDependencies`

All dependencies are optional; defaults give you the standard RunCell-backed pipeline.

| Field                 | Type                                        | Purpose                                                                    |
| --------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| `credentialProfiles`  | `Record<string, DiffowlCredentials>`        | Resolves `credentialProfile` names from role profiles. See [Credentials](../../guides/credentials/). |
| `executeRole`         | `RoleExecutor`                              | Replace provider execution entirely (tests, custom runtimes).              |
| `verificationAdapter` | `VerificationAdapter`                       | Supply repository file reads and validation execution for your environment. |
| `persistence`         | `ReviewPersistenceStore`                    | Durable ledger, run records, and artifacts.                                |
| `runId`               | `string`                                    | Stable run identity; generated when omitted.                               |
| `engineVersion`       | `string`                                    | Recorded in run records.                                                   |
| `mergeBaseSha`        | `string`                                    | Merge-base context for the run record.                                     |
| Discussion inputs     | fingerprints, dispositions, events          | Feed finding-command state into ledger reconciliation.                     |

### Persistence

`FileSystemReviewPersistenceStore` is exported for filesystem state:

```ts
import { FileSystemReviewPersistenceStore } from "diffowl";

const persistence = new FileSystemReviewPersistenceStore("/srv/diffowl-state");
```

Implement `ReviewPersistenceStore` yourself to back state with something else. The store owns transactions keyed by `{ repository, pullRequestNumber }` and must keep ledger and run records consistent; partial writes are how findings lose identity.

### Verification adapter

The `VerificationAdapter` interface is the engine's window into the repository and the validation sandbox:

```ts
interface VerificationAdapter {
  readRepositoryFile(request: RepositoryEvidenceRequest):
    Promise<{ content: string; truncated: boolean } | undefined>;
  executeValidation(request: ValidationExecutionRequest):
    Promise<Omit<ValidationAttempt, "commandIndex" | "argv" | "timeoutSeconds">>;
  validateSuggestedPatch?(request: SuggestedPatchValidationRequest):
    Promise<SuggestedPatchValidationResult>;
}
```

`createHostVerificationAdapter` (used by the CLI) reads files and runs argv commands on the host. In an embedding, respect the byte caps in the requests (`maxBytes`, `maxOutputBytes`) and honor the abort signal; the engine relies on both for its resource guarantees.

### Custom role execution

`executeRole` receives one `RoleExecutionRequest` per orchestration step (reviewer, challenger, verifier) and returns either a completed `RoleOutput` with an artifact or a typed failure (`provider_failure`, `budget_limit`, `resource_limit`). This is the hook for deterministic tests and for runtimes other than RunCell.

## Consuming outcomes in CI

A minimal gate in any CI system:

```ts
const outcome = await runReview(input, dependencies);

switch (outcome.type) {
  case "clean":
    break; // ready for human review
  case "findings":
    reportFindings(outcome.materialFindings);
    process.exitCode = 1;
    break;
  default:
    // partial, skipped, limited, failed, abstained: never treat as clean
    console.error(outcome.type, "reason" in outcome ? outcome.reason : "");
    process.exitCode = 1;
}
```

Serialize the full outcome if you archive results; `run.outcome` inside run metadata is the safe (secret-free) record shape.

## Synthetic evaluation

The entry point also exports the evaluation and release-gate helpers:

```ts
import {
  evaluateSyntheticCorpus,
  createV1ReleaseReportCard,
  evaluateV1ReleaseGate,
} from "diffowl";
```

A synthetic corpus pairs material-finding cases with clean controls and expected typed outcomes. `evaluateSyntheticCorpus` produces per-case reports; the release-gate helpers aggregate them into a report card with required evidence and threat-test ids. See [`examples/synthetic-evaluation-corpus.json`](https://github.com/D4NZ-jpg/diffowl/blob/main/examples/synthetic-evaluation-corpus.json) for the corpus shape.

## What embeddings must not do

- Do not construct a `TrustClassification` with hand-rolled permissive capabilities.
- Do not publish engine output to GitHub yourself from an untrusted context; publication belongs to a SHA-bound, data-only publisher.
- Do not treat any outcome other than `clean` and `findings` as a completed review.
- Do not reuse a state directory across repositories you do not trust equally; state is per base repository by design.
