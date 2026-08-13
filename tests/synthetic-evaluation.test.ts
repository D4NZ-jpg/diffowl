import { describe, expect, it } from "vitest";

import {
  evaluateSyntheticCorpus,
  type ReviewOutcome,
  type SyntheticEvaluationObservation,
} from "../src/review-engine.js";
import { createFindingFingerprint } from "../src/finding-fingerprint.js";
import {
  completedReviewOutcome,
  projectPolicy,
  reviewedPullRequest,
  trustedSameRepoTrust,
} from "./review-fixtures.js";

const expectedFingerprint = createFindingFingerprint({
  claimKind: "material_bug",
  summary: "Null user crashes the greeting endpoint",
  affectedArea: "src/greeting.ts",
  evidenceAnchors: [{ kind: "test", path: "src/greeting.ts", excerpt: "user.name" }],
  policyOrCapability: "runtime_correctness",
  location: { path: "src/greeting.ts", symbol: "greet" },
});

const unexpectedFingerprint = createFindingFingerprint({
  claimKind: "material_bug",
  summary: "Unexpected cache invalidation bug",
  affectedArea: "src/cache.ts",
  evidenceAnchors: [{ kind: "test", path: "src/cache.ts", excerpt: "stale" }],
  policyOrCapability: "runtime_correctness",
  location: { path: "src/cache.ts", symbol: "read" },
});

function baseCleanOutcome(): Extract<ReviewOutcome, { type: "clean" }> {
  return completedReviewOutcome({
    trust: trustedSameRepoTrust,
    policy: projectPolicy(),
    policySource: {
      type: "trusted_base_branch",
      revision: reviewedPullRequest.baseSha,
      path: ".diffowl.json",
    },
    verification: {
      evidenceCatalog: [],
      validationAttempts: [],
      limitations: [],
      coverageGaps: [],
    },
  }) as unknown as Extract<ReviewOutcome, { type: "clean" }>;
}

function findingsOutcome(): Extract<ReviewOutcome, { type: "findings" }> {
  return {
    ...baseCleanOutcome(),
    type: "findings",
    materialFindings: [
      {
        fingerprint: expectedFingerprint,
        summary: "Null user crashes the greeting endpoint",
        location: { path: "src/greeting.ts", line: 12 },
        impact: "Requests fail with a 500 response.",
        evidence: [],
        lifecycleState: "new",
        verificationState: {
          type: "verified",
          explanation: "The diff dereferences user.name.",
          limitations: [],
        },
      },
    ],
  };
}

function reportFor(observations: SyntheticEvaluationObservation[]) {
  return evaluateSyntheticCorpus(
    {
      version: 1,
      name: "release smoke corpus",
      cases: [
        {
          id: "material-null-user",
          name: "Null user regression",
          kind: "material_findings",
          expectedOutcome: "findings",
          expectedMaterialFindings: [
            {
              id: "null-user",
              summary: "Null user crashes the greeting endpoint",
              fingerprint: expectedFingerprint.value,
              locationPath: "src/greeting.ts",
            },
            {
              id: "missing-authz",
              summary: "Missing authorization guard",
              locationPath: "src/authz.ts",
            },
          ],
        },
        {
          id: "clean-docs",
          name: "Documentation-only clean control",
          kind: "clean_control",
          expectedOutcome: "clean",
          expectedMaterialFindings: [],
        },
      ],
    },
    observations,
  );
}

// oxlint-disable-next-line max-lines-per-function
describe("evaluateSyntheticCorpus", () => {
  it("records expected material findings found and missed", () => {
    const report = reportFor([{ caseId: "material-null-user", outcome: findingsOutcome() }]);

    expect(report.summary.expectedMaterialFindings).toEqual({ total: 2, found: 1, missed: 1 });
    expect(report.cases[0]?.materialFindings).toMatchObject({
      expected: [
        { id: "null-user", status: "found" },
        { id: "missing-authz", status: "missed" },
      ],
      unexpected: [],
    });
  });

  // oxlint-disable-next-line max-lines-per-function
  it("reports unexpected findings and advisory suggestions for clean controls", () => {
    const cleanControlOutcome: ReviewOutcome = {
      ...findingsOutcome(),
      materialFindings: [
        {
          ...findingsOutcome().materialFindings[0]!,
          fingerprint: unexpectedFingerprint,
          summary: "Unexpected cache invalidation bug",
          location: { path: "src/cache.ts" },
        },
      ],
      advisorySuggestions: [{ summary: "Rename a helper", rationale: "The name is vague." }],
    };

    const report = reportFor([{ caseId: "clean-docs", outcome: cleanControlOutcome }]);

    expect(report.summary.cleanControls).toEqual({
      total: 1,
      clean: 0,
      unexpectedMaterialFindings: 1,
      advisorySuggestions: 1,
    });
    expect(report.cases[1]?.cleanControl).toEqual({
      unexpectedMaterialFindingCount: 1,
      advisorySuggestionCount: 1,
      passed: false,
    });
  });

  it("does not count unobserved clean controls as passing", () => {
    const report = reportFor([]);

    expect(report.cases[1]).toMatchObject({
      observed: false,
      cleanControl: {
        unexpectedMaterialFindingCount: 0,
        advisorySuggestionCount: 0,
        passed: false,
      },
    });
    expect(report.summary.cleanControls).toEqual({
      total: 1,
      clean: 0,
      unexpectedMaterialFindings: 0,
      advisorySuggestions: 0,
    });
  });

  it("includes typed outcome categories and review-ready diagnostics", () => {
    const timeoutOutcome: ReviewOutcome = {
      type: "timeout",
      timeoutSeconds: 30,
      pullRequest: reviewedPullRequest,
      policy: {
        source: { type: "local_invocation", path: ".diffowl.json" },
        effective: projectPolicy(),
      },
      executionArtifacts: [],
      trust: trustedSameRepoTrust,
    };

    const report = reportFor([
      {
        caseId: "material-null-user",
        outcome: timeoutOutcome,
        reviewReadyLatencyMs: 12_345,
        diagnostics: {
          inputTokens: 100,
          outputTokens: 25,
          totalTokens: 125,
          costUsd: 0.42,
          runtimeMs: 12_000,
        },
      },
    ]);

    expect(report.cases[0]?.outcome).toEqual({
      expected: "findings",
      actual: "timeout",
      category: "timeout",
      matched: false,
    });
    expect(report.summary.outcomes).toMatchObject({
      timeout: 1,
      completed: 0,
      provider: 0,
      configuration: 0,
      internal: 0,
    });
    expect(report.cases[0]?.diagnostics).toEqual({
      reviewReadyLatencyMs: 12_345,
      tokens: { input: 100, output: 25, total: 125 },
      costUsd: 0.42,
      runtimeMs: 12_000,
    });
  });
});
