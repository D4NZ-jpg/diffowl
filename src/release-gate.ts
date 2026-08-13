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
  "timeout_non_clean",
  "provider_failure_non_clean",
  "unsafe_validation_denial",
  "data_only_publication",
] as const;

export type V1ThreatTestId = (typeof REQUIRED_V1_THREAT_TEST_IDS)[number];

export interface ThreatTestResult {
  id: V1ThreatTestId;
  name: string;
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
}

export interface V1ReleaseGateResult {
  passed: boolean;
  failures: string[];
}

export function createV1ReleaseReportCard(
  syntheticEvaluation: ReleaseReportCard,
  threatTests: readonly ThreatTestResult[],
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

function threatFailures(results: readonly ThreatTestResult[]): string[] {
  const byId = new Map(results.map((result) => [result.id, result]));
  return REQUIRED_V1_THREAT_TEST_IDS.flatMap((id) => {
    const result = byId.get(id);
    if (result === undefined) return [`Threat test ${id} is missing.`];
    if (!result.passed) return [`Threat test ${id} did not pass.`];
    return result.evidence.length === 0 ? [`Threat test ${id} has no evidence.`] : [];
  });
}

export function evaluateV1ReleaseGate(report: V1ReleaseReportCard): V1ReleaseGateResult {
  const failures = [
    ...syntheticFailures(report.syntheticEvaluation),
    ...threatFailures(report.security.threatTests.results),
  ];
  return { passed: failures.length === 0, failures };
}
