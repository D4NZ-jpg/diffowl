import { describe, expect, it } from "vitest";

import {
  REQUIRED_V1_THREAT_TEST_IDS,
  createV1ReleaseReportCard,
  evaluateSyntheticCorpus,
  evaluateV1ReleaseGate,
  type ReviewOutcome,
  type ThreatTestResult,
} from "../src/review-engine.js";
import { projectPolicy, reviewedPullRequest, trustedSameRepoTrust } from "./review-fixtures.js";

function syntheticReport() {
  const cleanOutcome: ReviewOutcome = {
    type: "clean",
    pullRequest: reviewedPullRequest,
    coverage: "completed_permitted",
    materialFindings: [],
    advisorySuggestions: [],
    orchestrationPlan: { maxCandidateFindings: 1, steps: [] },
    executionArtifacts: [],
    verification: {
      evidenceCatalog: [],
      validationAttempts: [],
      limitations: [],
      coverageGaps: [],
    },
    trust: trustedSameRepoTrust,
    policy: {
      source: {
        type: "trusted_base_branch",
        revision: reviewedPullRequest.baseSha,
        path: ".diffowl.json",
      },
      effective: projectPolicy(),
    },
  };
  return evaluateSyntheticCorpus(
    {
      version: 1,
      name: "release gate corpus",
      cases: [
        {
          id: "clean-control",
          name: "Clean control",
          kind: "clean_control",
          expectedOutcome: "clean",
          expectedMaterialFindings: [],
        },
      ],
    },
    [{ caseId: "clean-control", outcome: cleanOutcome }],
  );
}

function passingThreatTests(): ThreatTestResult[] {
  return REQUIRED_V1_THREAT_TEST_IDS.map((id) => ({
    id,
    name: id.replaceAll("_", " "),
    passed: true,
    evidence: [`${id} regression test passed`],
  }));
}

describe("V1 release gate", () => {
  it("passes only when synthetic evaluation and every required threat test are present", () => {
    const reportCard = createV1ReleaseReportCard(syntheticReport(), passingThreatTests());

    expect(reportCard.security.threatTests.required).toEqual([...REQUIRED_V1_THREAT_TEST_IDS]);
    expect(reportCard.security.threatTests.results).toHaveLength(
      REQUIRED_V1_THREAT_TEST_IDS.length,
    );
    expect(evaluateV1ReleaseGate(reportCard)).toEqual({ passed: true, failures: [] });
  });

  it("fails when synthetic evaluation evidence is missing", () => {
    const gate = evaluateV1ReleaseGate({
      version: 1,
      syntheticEvaluation: undefined,
      security: {
        threatTests: { required: [...REQUIRED_V1_THREAT_TEST_IDS], results: passingThreatTests() },
      },
    });

    expect(gate).toEqual({
      passed: false,
      failures: ["Synthetic evaluation results are required."],
    });
  });

  it("fails when any required threat test result is missing or failing", () => {
    const [first, ...remaining] = passingThreatTests();
    const reportCard = createV1ReleaseReportCard(syntheticReport(), [
      ...remaining,
      { ...first!, passed: false, evidence: ["regression failed"] },
    ]);

    expect(evaluateV1ReleaseGate(reportCard)).toEqual({
      passed: false,
      failures: [`Threat test ${first!.id} did not pass.`],
    });

    expect(
      evaluateV1ReleaseGate(
        createV1ReleaseReportCard(syntheticReport(), [...remaining, { ...first!, evidence: [] }]),
      ),
    ).toEqual({ passed: false, failures: [`Threat test ${first!.id} has no evidence.`] });

    expect(evaluateV1ReleaseGate(createV1ReleaseReportCard(syntheticReport(), remaining))).toEqual({
      passed: false,
      failures: [`Threat test ${first!.id} is missing.`],
    });
  });
});
