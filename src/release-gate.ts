import type { ReleaseReportCard } from "./synthetic-evaluation.js";

export const REQUIRED_V1_THREAT_TEST_IDS = [
  "fork_restrictions",
  "dependabot_restrictions",
  "secret_non_exposure",
  "base_branch_policy_loading",
  "non_overridable_ceilings",
  "privileged_publisher_validation",
  "exact_head_sha_binding",
  "stale_head_prevention",
  "malicious_command_rejection",
  "forged_finding_identity_rejection",
  "poisoned_input_rejection",
  "state_tampering_detection",
  "permission_loss_failure",
  "concurrent_writer_reconciliation",
  "patch_isolation",
  "partial_github_failure_reconciliation",
  "timeout_non_clean",
  "provider_failure_non_clean",
  "unsafe_validation_denial",
  "data_only_publication",
] as const;

export const REQUIRED_V1_RELEASE_EVIDENCE_IDS = [
  "installation_contract",
  "packaged_action_distribution",
  "representative_workflows",
  "readme_guidance",
  "author_review_request_path",
  "author_finding_discussion_path",
  "targeted_human_findings_path",
  "targeted_human_clean_path",
  "workflow_check_readiness",
  "job_summary_delivery",
  "actionable_findings_review",
  "partial_publication_failure",
] as const;

export type V1ThreatTestId = (typeof REQUIRED_V1_THREAT_TEST_IDS)[number];
export type V1ReleaseEvidenceId = (typeof REQUIRED_V1_RELEASE_EVIDENCE_IDS)[number];

export interface ThreatTestResult {
  id: V1ThreatTestId;
  name: string;
  passed: boolean;
  evidence: string[];
}

export interface ReleaseEvidenceResult {
  id: V1ReleaseEvidenceId;
  passed: boolean;
  evidence: string[];
}

export interface V1ReleaseReportCard {
  version: 1;
  syntheticEvaluation: ReleaseReportCard | undefined;
  security: {
    threatTests: {
      required: V1ThreatTestId[];
      results: ThreatTestResult[];
    };
  };
  releaseEvidence: {
    required: V1ReleaseEvidenceId[];
    results: ReleaseEvidenceResult[];
  };
}

export interface V1ReleaseGateResult {
  passed: boolean;
  failures: string[];
}

export function createV1ReleaseReportCard(
  syntheticEvaluation: ReleaseReportCard,
  threatTests: readonly ThreatTestResult[],
  releaseEvidence: readonly ReleaseEvidenceResult[] = [],
): V1ReleaseReportCard {
  return {
    version: 1,
    syntheticEvaluation,
    security: {
      threatTests: {
        required: [...REQUIRED_V1_THREAT_TEST_IDS],
        results: [...threatTests],
      },
    },
    releaseEvidence: {
      required: [...REQUIRED_V1_RELEASE_EVIDENCE_IDS],
      results: [...releaseEvidence],
    },
  };
}

function syntheticFailures(report: ReleaseReportCard | undefined): string[] {
  if (report === undefined) return ["Synthetic evaluation results are required."];
  const failures: string[] = [];
  if (report.summary.observedCaseCount !== report.corpus.caseCount) {
    failures.push("Every synthetic evaluation case must have an observation.");
  }
  if (report.cases.some((testCase) => testCase.outcome?.matched === false)) {
    failures.push("Every synthetic evaluation case must match its expected outcome.");
  }
  return failures;
}

function evidenceFailures<Id extends string>(
  required: readonly Id[],
  results: readonly { id: Id; passed: boolean; evidence: string[] }[],
  label: string,
): string[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  return required.flatMap((id) => {
    const result = byId.get(id);
    if (result === undefined) return [`${label} ${id} is missing.`];
    if (!result.passed) return [`${label} ${id} did not pass.`];
    return result.evidence.length === 0 ? [`${label} ${id} has no evidence.`] : [];
  });
}

export function evaluateV1ReleaseGate(report: V1ReleaseReportCard): V1ReleaseGateResult {
  const failures = [
    ...syntheticFailures(report.syntheticEvaluation),
    ...evidenceFailures(
      REQUIRED_V1_THREAT_TEST_IDS,
      report.security.threatTests.results,
      "Threat test",
    ),
    ...evidenceFailures(
      REQUIRED_V1_RELEASE_EVIDENCE_IDS,
      report.releaseEvidence?.results ?? [],
      "Release evidence",
    ),
  ];
  return { passed: failures.length === 0, failures };
}
