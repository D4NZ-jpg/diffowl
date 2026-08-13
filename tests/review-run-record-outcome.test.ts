import { expect, it } from "vitest";

import { createFindingFingerprint } from "../src/finding-fingerprint.js";
import type { ProjectPolicy } from "../src/project-policy.js";
import type { ReviewOutcome } from "../src/review-outcome.js";
import { createReviewRunRecord, parseReviewRunRecord } from "../src/review-run-record.js";
import { projectPolicy, reviewedPullRequest, trustedSameRepoTrust } from "./review-fixtures.js";
import { cleanOutcome, createRecord, policySource } from "./review-run-record-fixtures.js";

function materialOutcome(policy: ProjectPolicy): ReviewOutcome {
  const fingerprint = createFindingFingerprint({
    claimKind: "auth-bypass",
    summary: "Authorization can be skipped",
    affectedArea: "authorization API",
    evidenceAnchors: [{ kind: "scoped_diff", path: "src/auth.ts", stableId: "authorize" }],
    policyOrCapability: "runtime correctness",
    location: { path: "src/auth.ts", symbol: "authorize" },
  });
  return {
    type: "partial_coverage",
    trust: trustedSameRepoTrust,
    pullRequest: reviewedPullRequest,
    policy: { source: policySource, effective: policy },
    reason: "secret raw diagnostic",
    materialFindings: [
      {
        fingerprint,
        summary: "Authorization can be skipped with secret token",
        location: { path: "src/auth.ts", line: 12 },
        impact: "secret impact details",
        evidence: [
          {
            id: "scoped-diff",
            type: "scoped_diff",
            path: "src/auth.ts",
            content: "secret",
            truncated: false,
          },
        ],
        lifecycleState: "persisting",
        verificationState: {
          type: "verified_with_limitations",
          explanation: "secret",
          limitations: ["one"],
        },
      },
    ],
    verification: {
      evidenceCatalog: [],
      validationAttempts: [],
      limitations: [],
      coverageGaps: ["gap"],
    },
    advisorySuggestions: [],
    executionArtifacts: [],
  };
}

it("persists safe finding snapshots and ledger transitions", () => {
  const policy = projectPolicy();
  const outcome = materialOutcome(policy);
  const fingerprint =
    outcome.type === "partial_coverage"
      ? (outcome.materialFindings?.[0]?.fingerprint.value ?? "")
      : "";
  const record = createReviewRunRecord({
    runId: "run-finding",
    recordedAt: "2026-01-02T03:04:05.000Z",
    engineVersion: "test",
    trust: trustedSameRepoTrust,
    policy,
    validationAttempts: [],
    finalOutcome: outcome,
    ledgerTransitions: [
      { fingerprint, lifecycleState: "persisting", previousLifecycleState: "new", changed: true },
    ],
  });

  expect(record.finalOutcome).toMatchObject({
    type: "partial_coverage",
    materialFindingCount: 1,
    coverageGapCount: 1,
    materialFindings: [
      {
        fingerprint,
        lifecycleState: "persisting",
        verificationState: "verified_with_limitations",
        verificationLimitationCount: 1,
        evidenceCount: 1,
      },
    ],
    ledgerTransitions: [expect.objectContaining({ changed: true })],
  });
  expect(JSON.stringify(record)).not.toContain("secret");
  expect(parseReviewRunRecord(record)).toEqual(record);
});

it("strictly validates final outcome discriminated fields", () => {
  const policy = projectPolicy();
  const record = createRecord(cleanOutcome(policy), policy);
  expect(() =>
    parseReviewRunRecord({
      ...record,
      finalOutcome: { ...record.finalOutcome, coverage: undefined },
    }),
  ).toThrow("not supported");
  expect(() =>
    parseReviewRunRecord({
      ...record,
      finalOutcome: { ...record.finalOutcome, timeoutSeconds: 1 },
    }),
  ).toThrow("not supported");
  expect(() =>
    parseReviewRunRecord({
      ...record,
      finalOutcome: { ...record.finalOutcome, materialFindingCount: 1 },
    }),
  ).toThrow("not supported");
  expect(() =>
    parseReviewRunRecord({
      ...record,
      finalOutcome: {
        ...record.finalOutcome,
        ledgerTransitions: [
          { fingerprint: "sha256:" + "1".repeat(64), lifecycleState: "invalid", changed: true },
        ],
      },
    }),
  ).toThrow("not supported");
});

it("requires finding lists for declared counts and strips unknown fields", () => {
  const policy = projectPolicy();
  const outcome = materialOutcome(policy);
  const record = createRecord(outcome, policy);
  expect(() =>
    parseReviewRunRecord({
      ...record,
      finalOutcome: { ...record.finalOutcome, materialFindings: undefined },
    }),
  ).toThrow("not supported");
  const unknownProviderModels = structuredClone(record.providerModels) as Array<
    (typeof record.providerModels)[number] & { unknownMetadataField: string }
  >;
  unknownProviderModels[0]!.unknownMetadataField = "discarded";
  const unknownAttempts = [
    {
      commandIndex: 0,
      commandHash: "sha256:" + "1".repeat(64),
      timeoutSeconds: 1,
      status: "passed" as const,
      truncated: false,
      limitation: false,
      unknownAttemptField: "discarded",
    },
  ];
  const unknownFindings = structuredClone(record.finalOutcome.materialFindings) as Array<
    NonNullable<typeof record.finalOutcome.materialFindings>[number] & {
      unknownFindingField: string;
    }
  >;
  unknownFindings[0]!.unknownFindingField = "discarded";
  const parsed = parseReviewRunRecord({
    ...record,
    unknownTopLevel: "discarded",
    revision: {
      ...record.revision,
      pullRequest: { ...record.revision?.pullRequest, unknownPullRequestField: "discarded" },
    },
    providerModels: unknownProviderModels,
    validationAttempts: unknownAttempts,
    finalOutcome: {
      ...record.finalOutcome,
      unknownOutcomeField: "discarded",
      materialFindings: unknownFindings,
    },
  });
  expect(JSON.stringify(parsed)).not.toContain("unknown");
});
