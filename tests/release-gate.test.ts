import { describe, expect, it } from "vitest";

import {
  REQUIRED_V1_RELEASE_EVIDENCE_IDS,
  REQUIRED_V1_THREAT_TEST_IDS,
  createV1ReleaseReportCard,
  evaluateSyntheticCorpus,
  evaluateV1ReleaseGate,
  type ReleaseEvidenceResult,
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

function passingReleaseEvidence(): ReleaseEvidenceResult[] {
  return REQUIRED_V1_RELEASE_EVIDENCE_IDS.map((id) => ({
    id,
    passed: true,
    evidence: [`${id} integration test passed`],
  }));
}

// oxlint-disable-next-line max-lines-per-function
describe("V1 release gate", () => {
  it("passes only when synthetic evaluation and every required threat test are present", () => {
    const reportCard = createV1ReleaseReportCard(
      syntheticReport(),
      passingThreatTests(),
      passingReleaseEvidence(),
    );

    expect(reportCard.security.threatTests.required).toEqual([...REQUIRED_V1_THREAT_TEST_IDS]);
    expect(reportCard.security.threatTests.required).toEqual(
      expect.arrayContaining([
        "malicious_command_rejection",
        "forged_finding_identity_rejection",
        "poisoned_input_rejection",
        "state_tampering_detection",
        "permission_loss_failure",
        "concurrent_writer_reconciliation",
        "patch_isolation",
        "partial_github_failure_reconciliation",
      ]),
    );
    expect(reportCard.security.threatTests.results).toHaveLength(
      REQUIRED_V1_THREAT_TEST_IDS.length,
    );
    expect(reportCard.releaseEvidence.required).toEqual(
      expect.arrayContaining([
        "author_review_request_path",
        "author_finding_discussion_path",
        "targeted_human_findings_path",
        "targeted_human_clean_path",
        "workflow_check_readiness",
        "job_summary_delivery",
        "actionable_findings_review",
        "partial_publication_failure",
      ]),
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
      releaseEvidence: {
        required: [...REQUIRED_V1_RELEASE_EVIDENCE_IDS],
        results: passingReleaseEvidence(),
      },
    });

    expect(gate).toEqual({
      passed: false,
      failures: ["Synthetic evaluation results are required."],
    });
  });

  it("fails when any required threat test result is missing or failing", () => {
    const [first, ...remaining] = passingThreatTests();
    const reportCard = createV1ReleaseReportCard(
      syntheticReport(),
      [...remaining, { ...first!, passed: false, evidence: ["regression failed"] }],
      passingReleaseEvidence(),
    );

    expect(evaluateV1ReleaseGate(reportCard)).toEqual({
      passed: false,
      failures: [`Threat test ${first!.id} did not pass.`],
    });

    expect(
      evaluateV1ReleaseGate(
        createV1ReleaseReportCard(
          syntheticReport(),
          [...remaining, { ...first!, evidence: [] }],
          passingReleaseEvidence(),
        ),
      ),
    ).toEqual({ passed: false, failures: [`Threat test ${first!.id} has no evidence.`] });

    expect(
      evaluateV1ReleaseGate(
        createV1ReleaseReportCard(syntheticReport(), remaining, passingReleaseEvidence()),
      ),
    ).toEqual({
      passed: false,
      failures: [`Threat test ${first!.id} is missing.`],
    });
  });

  it("fails without complete author, targeted-reviewer, publication, and package evidence", () => {
    const [first, ...remaining] = passingReleaseEvidence();
    const gate = evaluateV1ReleaseGate(
      createV1ReleaseReportCard(syntheticReport(), passingThreatTests(), remaining),
    );

    expect(gate).toEqual({
      passed: false,
      failures: [`Release evidence ${first!.id} is missing.`],
    });
  });

  it("fails when partial GitHub publication behavior remains", () => {
    const releaseEvidence = passingReleaseEvidence().map((result) =>
      result.id === "partial_publication_failure"
        ? { id: result.id, passed: false, evidence: result.evidence }
        : result,
    );

    expect(
      evaluateV1ReleaseGate(
        createV1ReleaseReportCard(syntheticReport(), passingThreatTests(), releaseEvidence),
      ),
    ).toEqual({
      passed: false,
      failures: ["Release evidence partial_publication_failure did not pass."],
    });
  });
});
