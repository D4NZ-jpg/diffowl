/* oxlint-disable max-lines */
import type { ReviewOutcome } from "./review-outcome.js";
import type { MaterialFinding } from "./review-orchestration.js";

export const SYNTHETIC_EVALUATION_CORPUS_VERSION = 1;

export type SyntheticEvaluationCaseKind = "material_findings" | "clean_control";

export type OutcomeCategory =
  | "completed"
  | "skip"
  | "partial"
  | "limit"
  | "timeout"
  | "provider"
  | "configuration"
  | "internal"
  | "abstention"
  | "unsupported";

export interface ExpectedSyntheticFinding {
  id: string;
  summary: string;
  fingerprint?: string | undefined;
  locationPath?: string | undefined;
}

export interface SyntheticEvaluationCase {
  id: string;
  name: string;
  kind: SyntheticEvaluationCaseKind;
  expectedOutcome: ReviewOutcome["type"];
  expectedMaterialFindings: ExpectedSyntheticFinding[];
}

export interface SyntheticEvaluationCorpus {
  version: typeof SYNTHETIC_EVALUATION_CORPUS_VERSION;
  name: string;
  cases: SyntheticEvaluationCase[];
}

export interface SyntheticEvaluationDiagnosticsInput {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  totalTokens?: number | undefined;
  costUsd?: number | undefined;
  runtimeMs?: number | undefined;
}

export interface SyntheticEvaluationObservation {
  caseId: string;
  outcome: ReviewOutcome;
  reviewReadyLatencyMs?: number | undefined;
  diagnostics?: SyntheticEvaluationDiagnosticsInput | undefined;
}

export interface SyntheticFindingResult extends ExpectedSyntheticFinding {
  status: "found" | "missed";
}

export interface UnexpectedSyntheticFinding {
  fingerprint: string;
  summary: string;
  locationPath: string;
}

export interface SyntheticReportTokenDiagnostics {
  input?: number | undefined;
  output?: number | undefined;
  total?: number | undefined;
}

export interface SyntheticCaseReport {
  id: string;
  name: string;
  kind: SyntheticEvaluationCaseKind;
  observed: boolean;
  outcome?:
    | {
        expected: ReviewOutcome["type"];
        actual: ReviewOutcome["type"];
        category: OutcomeCategory;
        matched: boolean;
      }
    | undefined;
  materialFindings: {
    expected: SyntheticFindingResult[];
    unexpected: UnexpectedSyntheticFinding[];
  };
  cleanControl?:
    | {
        unexpectedMaterialFindingCount: number;
        advisorySuggestionCount: number;
        passed: boolean;
      }
    | undefined;
  diagnostics?:
    | {
        reviewReadyLatencyMs?: number | undefined;
        tokens?: SyntheticReportTokenDiagnostics | undefined;
        costUsd?: number | undefined;
        runtimeMs?: number | undefined;
      }
    | undefined;
}

export interface ReleaseReportCard {
  version: 1;
  corpus: { name: string; caseCount: number };
  summary: {
    observedCaseCount: number;
    expectedMaterialFindings: { total: number; found: number; missed: number };
    cleanControls: {
      total: number;
      clean: number;
      unexpectedMaterialFindings: number;
      advisorySuggestions: number;
    };
    outcomes: Record<OutcomeCategory, number>;
  };
  cases: SyntheticCaseReport[];
}

const outcomeCategories: Record<ReviewOutcome["type"], OutcomeCategory> = {
  clean: "completed",
  findings: "completed",
  policy_skip: "skip",
  partial_coverage: "partial",
  budget_limit: "limit",
  resource_limit: "limit",
  timeout: "timeout",
  provider_failure: "provider",
  configuration_failure: "configuration",
  internal_failure: "internal",
  abstention: "abstention",
  unsupported_change: "unsupported",
};

function outcomeCategory(type: ReviewOutcome["type"]): OutcomeCategory {
  return outcomeCategories[type];
}

function materialFindings(outcome: ReviewOutcome | undefined): MaterialFinding[] {
  return outcome !== undefined &&
    "materialFindings" in outcome &&
    outcome.materialFindings !== undefined
    ? outcome.materialFindings
    : [];
}

function advisorySuggestionCount(outcome: ReviewOutcome | undefined): number {
  return outcome !== undefined &&
    "advisorySuggestions" in outcome &&
    outcome.advisorySuggestions !== undefined
    ? outcome.advisorySuggestions.length
    : 0;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function findingMatches(expected: ExpectedSyntheticFinding, actual: MaterialFinding): boolean {
  if (expected.fingerprint !== undefined) return actual.fingerprint.value === expected.fingerprint;
  const sameSummary = normalized(actual.summary) === normalized(expected.summary);
  return expected.locationPath === undefined
    ? sameSummary
    : sameSummary && actual.location.path === expected.locationPath;
}

function expectedFindingResults(
  expected: readonly ExpectedSyntheticFinding[],
  actual: readonly MaterialFinding[],
): SyntheticFindingResult[] {
  return expected.map((finding) => ({
    ...finding,
    status: actual.some((actualFinding) => findingMatches(finding, actualFinding))
      ? "found"
      : "missed",
  }));
}

function unexpectedFindings(
  expected: readonly ExpectedSyntheticFinding[],
  actual: readonly MaterialFinding[],
): UnexpectedSyntheticFinding[] {
  return actual
    .filter(
      (finding) => !expected.some((expectedFinding) => findingMatches(expectedFinding, finding)),
    )
    .map((finding) => ({
      fingerprint: finding.fingerprint.value,
      summary: finding.summary,
      locationPath: finding.location.path,
    }));
}

function tokenDiagnostics(
  diagnostics: SyntheticEvaluationDiagnosticsInput | undefined,
): SyntheticReportTokenDiagnostics | undefined {
  if (diagnostics === undefined) return undefined;
  const tokens = {
    input: diagnostics.inputTokens,
    output: diagnostics.outputTokens,
    total: diagnostics.totalTokens,
  };
  return Object.values(tokens).every((value) => value === undefined) ? undefined : tokens;
}

function caseDiagnostics(
  observation: SyntheticEvaluationObservation | undefined,
): SyntheticCaseReport["diagnostics"] {
  if (observation === undefined) return undefined;
  const diagnostics = observation.diagnostics;
  const tokens = tokenDiagnostics(diagnostics);
  const report = {
    reviewReadyLatencyMs: observation.reviewReadyLatencyMs,
    ...(tokens === undefined ? {} : { tokens }),
    ...(diagnostics?.costUsd === undefined ? {} : { costUsd: diagnostics.costUsd }),
    ...(diagnostics?.runtimeMs === undefined ? {} : { runtimeMs: diagnostics.runtimeMs }),
  };
  return Object.keys(report).length === 0 ? undefined : report;
}

function emptyOutcomeCounts(): Record<OutcomeCategory, number> {
  return {
    completed: 0,
    skip: 0,
    partial: 0,
    limit: 0,
    timeout: 0,
    provider: 0,
    configuration: 0,
    internal: 0,
    abstention: 0,
    unsupported: 0,
  };
}

function reportCase(
  testCase: SyntheticEvaluationCase,
  observation: SyntheticEvaluationObservation | undefined,
): SyntheticCaseReport {
  const findings = materialFindings(observation?.outcome);
  const expected = expectedFindingResults(testCase.expectedMaterialFindings, findings);
  const unexpected = unexpectedFindings(testCase.expectedMaterialFindings, findings);
  const advisoryCount = advisorySuggestionCount(observation?.outcome);
  return {
    id: testCase.id,
    name: testCase.name,
    kind: testCase.kind,
    observed: observation !== undefined,
    ...(observation === undefined
      ? {}
      : {
          outcome: {
            expected: testCase.expectedOutcome,
            actual: observation.outcome.type,
            category: outcomeCategory(observation.outcome.type),
            matched: testCase.expectedOutcome === observation.outcome.type,
          },
        }),
    materialFindings: { expected, unexpected },
    ...(testCase.kind === "clean_control"
      ? {
          cleanControl: {
            unexpectedMaterialFindingCount: findings.length,
            advisorySuggestionCount: advisoryCount,
            passed: observation !== undefined && findings.length === 0 && advisoryCount === 0,
          },
        }
      : {}),
    ...(caseDiagnostics(observation) === undefined
      ? {}
      : { diagnostics: caseDiagnostics(observation) }),
  };
}

export function evaluateSyntheticCorpus(
  corpus: SyntheticEvaluationCorpus,
  observations: readonly SyntheticEvaluationObservation[],
): ReleaseReportCard {
  const observedByCase = new Map(
    observations.map((observation) => [observation.caseId, observation]),
  );
  const cases = corpus.cases.map((testCase) =>
    reportCase(testCase, observedByCase.get(testCase.id)),
  );
  const outcomeCounts = emptyOutcomeCounts();
  for (const report of cases) {
    if (report.outcome !== undefined) outcomeCounts[report.outcome.category] += 1;
  }
  const allExpected = cases.flatMap((report) => report.materialFindings.expected);
  const cleanControls = cases.filter((report) => report.kind === "clean_control");
  return {
    version: 1,
    corpus: { name: corpus.name, caseCount: corpus.cases.length },
    summary: {
      observedCaseCount: cases.filter((report) => report.observed).length,
      expectedMaterialFindings: {
        total: allExpected.length,
        found: allExpected.filter((finding) => finding.status === "found").length,
        missed: allExpected.filter((finding) => finding.status === "missed").length,
      },
      cleanControls: {
        total: cleanControls.length,
        clean: cleanControls.filter((report) => report.cleanControl?.passed === true).length,
        unexpectedMaterialFindings: cleanControls.reduce(
          (sum, report) => sum + (report.cleanControl?.unexpectedMaterialFindingCount ?? 0),
          0,
        ),
        advisorySuggestions: cleanControls.reduce(
          (sum, report) => sum + (report.cleanControl?.advisorySuggestionCount ?? 0),
          0,
        ),
      },
      outcomes: outcomeCounts,
    },
    cases,
  };
}
