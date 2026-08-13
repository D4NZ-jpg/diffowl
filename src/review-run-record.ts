/* oxlint-disable max-lines */
import {
  canonicalJsonHash,
  isJsonObject,
  type JsonValue,
  requireJsonVersion,
} from "./canonical-json.js";
import type { ProjectPolicy } from "./project-policy.js";
import type { ReviewOutcome } from "./review-outcome.js";
import type {
  FindingLifecycleState,
  FindingVerificationState,
  MaterialFinding,
  ReviewedPullRequest,
  SuppressedFinding,
  ValidationAttempt,
} from "./review-orchestration.js";
import type { TrustClassification } from "./trust.js";

export const REVIEW_RUN_RECORD_VERSION = 1;

const shaPattern = /^[\da-f]{40,64}$/iu;
const hashPattern = /^sha256:[\da-f]{64}$/u;
const lifecycleStates = new Set<FindingLifecycleState>([
  "new",
  "persisting",
  "resolved",
  "obsolete",
  "rebutted",
  "accepted",
  "suppressed",
]);

const trustClasses = new Set<TrustClassification["class"]>([
  "trusted_same_repo_pull_request",
  "untrusted_pull_request",
  "local_cli",
  "privileged_publisher",
  "unsafe_or_unsupported",
]);

export interface PullRequestRevisionContext {
  pullRequest: ReviewedPullRequest;
  mergeBaseSha?: string | undefined;
}

export interface SafeProviderModelMetadata {
  role: string;
  provider: string;
  model: string;
}

export interface BudgetEnvelopeRecord {
  reviewTimeoutSeconds: number;
  maxFindings: number;
  validationCommandCount: number;
}

export interface SafeValidationAttemptRecord {
  commandIndex: number;
  commandHash: string;
  timeoutSeconds: number;
  status: ValidationAttempt["status"];
  exitCode?: number | undefined;
  truncated: boolean;
  limitation: boolean;
}

export interface SafeFindingOutcomeRecord {
  fingerprint: string;
  lifecycleState: FindingLifecycleState;
  verificationState: FindingVerificationState["type"];
  verificationLimitationCount: number;
  evidenceCount: number;
}

export interface SafeSuppressedFindingRecord {
  fingerprint: string;
}

export interface SafeLedgerTransitionRecord {
  fingerprint: string;
  lifecycleState: FindingLifecycleState;
  previousLifecycleState?: FindingLifecycleState | undefined;
  changed: boolean;
}

export interface SafeReviewOutcomeRecord {
  type: ReviewOutcome["type"];
  coverage?: "completed_permitted" | undefined;
  timeoutSeconds?: number | undefined;
  materialFindingCount?: number | undefined;
  advisorySuggestionCount?: number | undefined;
  validationAttemptCount?: number | undefined;
  coverageGapCount?: number | undefined;
  executionArtifactCount?: number | undefined;
  suppressedFindingCount?: number | undefined;
  materialFindings?: SafeFindingOutcomeRecord[] | undefined;
  suppressedFindings?: SafeSuppressedFindingRecord[] | undefined;
  ledgerTransitions?: SafeLedgerTransitionRecord[] | undefined;
  diagnosticPresent: boolean;
}

export interface SafeReviewOutcomeOptions {
  suppressedFindings?: readonly SuppressedFinding[] | undefined;
  ledgerTransitions?: readonly SafeLedgerTransitionRecord[] | undefined;
}

export interface ReviewRunRecord {
  version: typeof REVIEW_RUN_RECORD_VERSION;
  runId: string;
  recordedAt: string;
  engineVersion: string;
  revision?: PullRequestRevisionContext | undefined;
  trustClass: TrustClassification["class"];
  policyStatus: "valid" | "unavailable";
  policyHash: string | null;
  providerModels: SafeProviderModelMetadata[];
  budget?: BudgetEnvelopeRecord | undefined;
  validationAttempts: SafeValidationAttemptRecord[];
  finalOutcome: SafeReviewOutcomeRecord;
}

export interface CreateReviewRunRecordInput {
  runId: string;
  recordedAt: string;
  engineVersion: string;
  revision?: PullRequestRevisionContext | undefined;
  trust?: TrustClassification | undefined;
  policy?: ProjectPolicy | undefined;
  unavailablePolicyContents?: string | undefined;
  validationAttempts: ValidationAttempt[];
  finalOutcome: ReviewOutcome;
  suppressedFindings?: readonly SuppressedFinding[] | undefined;
  ledgerTransitions?: readonly SafeLedgerTransitionRecord[] | undefined;
}

export function canonicalPolicyHash(policy: ProjectPolicy): string {
  return canonicalJsonHash(policy as unknown as JsonValue);
}

const metadataPattern = /^[A-Za-z0-9][A-Za-z0-9._/@:+-]{0,199}$/u;
const secretMetadataPattern =
  /(?:bearer|api[_-]?key|secret|token|password|sk-[\w-]{8}|ghp_[\w-]+|github_pat_[\w-]+|AKIA[A-Z0-9]{12,})/iu;

function safeMetadata(value: string): string {
  const normalized = value.normalize("NFKC");
  return normalized.length <= 200 &&
    metadataPattern.test(normalized) &&
    !secretMetadataPattern.test(normalized)
    ? normalized
    : "[redacted]";
}

function providerModels(policy: ProjectPolicy | undefined): SafeProviderModelMetadata[] {
  if (policy === undefined) return [];
  return Object.entries(policy.roleProfiles).map(([role, profile]) => ({
    role,
    provider: safeMetadata(profile.provider),
    model: safeMetadata(profile.model),
  }));
}

function budget(policy: ProjectPolicy | undefined): BudgetEnvelopeRecord | undefined {
  if (policy === undefined) return undefined;
  return {
    reviewTimeoutSeconds: policy.limits.reviewTimeoutSeconds,
    maxFindings: policy.limits.maxFindings,
    validationCommandCount: policy.verification.validationCommands.length,
  };
}

function safeValidationAttempt(attempt: ValidationAttempt): SafeValidationAttemptRecord {
  return {
    commandIndex: attempt.commandIndex,
    commandHash: canonicalJsonHash(attempt.argv),
    timeoutSeconds: attempt.timeoutSeconds,
    status: attempt.status,
    exitCode: attempt.exitCode,
    truncated: attempt.truncated,
    limitation: attempt.limitation !== undefined,
  };
}

function verificationSummary(outcome: ReviewOutcome): { attempts?: number; gaps?: number } {
  if (!("verification" in outcome) || outcome.verification === undefined) return {};
  return {
    attempts: outcome.verification.validationAttempts.length,
    gaps: outcome.verification.coverageGaps.length,
  };
}

function safeFinding(finding: MaterialFinding): SafeFindingOutcomeRecord {
  return {
    fingerprint: finding.fingerprint.value,
    lifecycleState: finding.lifecycleState,
    verificationState: finding.verificationState.type,
    verificationLimitationCount: finding.verificationState.limitations.length,
    evidenceCount: finding.evidence.length,
  };
}

function safeSuppressedFinding(finding: SuppressedFinding): SafeSuppressedFindingRecord {
  return { fingerprint: finding.fingerprint.value };
}

function materialFindings(outcome: ReviewOutcome): MaterialFinding[] | undefined {
  if (!("materialFindings" in outcome)) return undefined;
  return outcome.materialFindings;
}

function advisorySuggestionCount(outcome: ReviewOutcome): number | undefined {
  if (!("advisorySuggestions" in outcome)) return undefined;
  return outcome.advisorySuggestions?.length;
}

function executionArtifactCount(outcome: ReviewOutcome): number | undefined {
  if (!("executionArtifacts" in outcome)) return undefined;
  return outcome.executionArtifacts?.length;
}

function completedCoverage(outcome: ReviewOutcome): "completed_permitted" | undefined {
  if (!("coverage" in outcome)) return undefined;
  return outcome.coverage;
}

function timeoutSeconds(outcome: ReviewOutcome): number | undefined {
  return outcome.type === "timeout" ? outcome.timeoutSeconds : undefined;
}

export function safeReviewOutcome(
  outcome: ReviewOutcome,
  options: SafeReviewOutcomeOptions = {},
): SafeReviewOutcomeRecord {
  const verification = verificationSummary(outcome);
  const currentFindings = materialFindings(outcome);
  const suppressedFindings = options.suppressedFindings?.map(safeSuppressedFinding);
  return {
    type: outcome.type,
    coverage: completedCoverage(outcome),
    timeoutSeconds: timeoutSeconds(outcome),
    materialFindingCount: currentFindings?.length,
    advisorySuggestionCount: advisorySuggestionCount(outcome),
    validationAttemptCount: verification.attempts,
    coverageGapCount: verification.gaps,
    executionArtifactCount: executionArtifactCount(outcome),
    suppressedFindingCount: suppressedFindings?.length,
    materialFindings: currentFindings?.map(safeFinding),
    suppressedFindings,
    ledgerTransitions: options.ledgerTransitions?.map((transition) => ({ ...transition })),
    diagnosticPresent: "reason" in outcome && outcome.reason.length > 0,
  };
}

function samePullRequest(left: ReviewedPullRequest, right: ReviewedPullRequest): boolean {
  return (
    left.repository === right.repository &&
    left.number === right.number &&
    left.baseSha === right.baseSha &&
    left.headSha === right.headSha
  );
}

function revision(input: CreateReviewRunRecordInput): PullRequestRevisionContext | undefined {
  const outcomePullRequest =
    "pullRequest" in input.finalOutcome ? input.finalOutcome.pullRequest : undefined;
  if (
    input.revision !== undefined &&
    outcomePullRequest !== undefined &&
    !samePullRequest(input.revision.pullRequest, outcomePullRequest)
  ) {
    throw new Error("Run record revision does not match final outcome.");
  }
  if (outcomePullRequest === undefined) return input.revision;
  return { pullRequest: outcomePullRequest, mergeBaseSha: input.revision?.mergeBaseSha };
}

export function createReviewRunRecord(input: CreateReviewRunRecordInput): ReviewRunRecord {
  if (input.trust !== undefined && input.trust.class !== input.finalOutcome.trust.class) {
    throw new Error("Run record trust class does not match final outcome.");
  }
  if (
    input.policy !== undefined &&
    "policy" in input.finalOutcome &&
    canonicalPolicyHash(input.policy) !== canonicalPolicyHash(input.finalOutcome.policy.effective)
  ) {
    throw new Error("Run record policy does not match final outcome.");
  }
  const effectivePolicy =
    "policy" in input.finalOutcome ? input.finalOutcome.policy.effective : input.policy;
  const policyHash =
    effectivePolicy !== undefined
      ? canonicalPolicyHash(effectivePolicy)
      : input.unavailablePolicyContents === undefined
        ? null
        : canonicalJsonHash(input.unavailablePolicyContents);
  return {
    version: REVIEW_RUN_RECORD_VERSION,
    runId: input.runId,
    recordedAt: input.recordedAt,
    engineVersion: input.engineVersion,
    revision: revision(input),
    trustClass: input.finalOutcome.trust.class,
    policyStatus: effectivePolicy === undefined ? "unavailable" : "valid",
    policyHash,
    providerModels: providerModels(effectivePolicy),
    budget: budget(effectivePolicy),
    validationAttempts: input.validationAttempts.map(safeValidationAttempt),
    finalOutcome: safeReviewOutcome(input.finalOutcome, {
      suppressedFindings: input.suppressedFindings,
      ledgerTransitions: input.ledgerTransitions,
    }),
  };
}

function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function nonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

// oxlint-disable-next-line complexity
function validRevision(value: unknown): value is PullRequestRevisionContext | undefined {
  if (value === undefined) return true;
  if (!isJsonObject(value) || !isJsonObject(value.pullRequest)) return false;
  const pullRequest = value.pullRequest;
  return (
    typeof pullRequest.repository === "string" &&
    positiveInteger(pullRequest.number) &&
    typeof pullRequest.baseSha === "string" &&
    shaPattern.test(pullRequest.baseSha) &&
    typeof pullRequest.headSha === "string" &&
    shaPattern.test(pullRequest.headSha) &&
    (value.mergeBaseSha === undefined ||
      (typeof value.mergeBaseSha === "string" && shaPattern.test(value.mergeBaseSha)))
  );
}

function validBudget(value: unknown): value is BudgetEnvelopeRecord {
  return (
    isJsonObject(value) &&
    positiveInteger(value.reviewTimeoutSeconds) &&
    positiveInteger(value.maxFindings) &&
    nonnegativeInteger(value.validationCommandCount)
  );
}

function validSafeMetadata(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 200 &&
    (value === "[redacted]" || (metadataPattern.test(value) && !secretMetadataPattern.test(value)))
  );
}

function validValidationAttempt(value: unknown): value is SafeValidationAttemptRecord {
  if (!isJsonObject(value)) return false;
  return (
    nonnegativeInteger(value.commandIndex) &&
    typeof value.commandHash === "string" &&
    hashPattern.test(value.commandHash) &&
    positiveInteger(value.timeoutSeconds) &&
    ["passed", "failed", "timed_out", "aborted", "error"].includes(String(value.status)) &&
    (value.exitCode === undefined || Number.isInteger(value.exitCode)) &&
    typeof value.truncated === "boolean" &&
    typeof value.limitation === "boolean"
  );
}

function validLifecycleState(value: unknown): value is FindingLifecycleState {
  return lifecycleStates.has(value as FindingLifecycleState);
}

function validSafeFinding(value: unknown): value is SafeFindingOutcomeRecord {
  return (
    isJsonObject(value) &&
    typeof value.fingerprint === "string" &&
    hashPattern.test(value.fingerprint) &&
    validLifecycleState(value.lifecycleState) &&
    (value.verificationState === "verified" ||
      value.verificationState === "verified_with_limitations") &&
    nonnegativeInteger(value.verificationLimitationCount) &&
    nonnegativeInteger(value.evidenceCount)
  );
}

function validSuppressedFinding(value: unknown): value is SafeSuppressedFindingRecord {
  return (
    isJsonObject(value) &&
    typeof value.fingerprint === "string" &&
    hashPattern.test(value.fingerprint)
  );
}

function validLedgerTransition(value: unknown): value is SafeLedgerTransitionRecord {
  return (
    isJsonObject(value) &&
    typeof value.fingerprint === "string" &&
    hashPattern.test(value.fingerprint) &&
    validLifecycleState(value.lifecycleState) &&
    (value.previousLifecycleState === undefined ||
      validLifecycleState(value.previousLifecycleState)) &&
    typeof value.changed === "boolean"
  );
}

function validCounts(value: Record<string, unknown>): boolean {
  const counts = [
    "materialFindingCount",
    "advisorySuggestionCount",
    "validationAttemptCount",
    "coverageGapCount",
    "executionArtifactCount",
    "suppressedFindingCount",
  ];
  return counts.every((key) => value[key] === undefined || nonnegativeInteger(value[key]));
}

function validMaterialFindingList(value: Record<string, unknown>): boolean {
  if (value.materialFindingCount === undefined) return value.materialFindings === undefined;
  return (
    Array.isArray(value.materialFindings) &&
    value.materialFindings.every(validSafeFinding) &&
    value.materialFindingCount === value.materialFindings.length
  );
}

function validSuppressedFindingList(value: Record<string, unknown>): boolean {
  if (value.suppressedFindingCount === undefined) return value.suppressedFindings === undefined;
  return (
    Array.isArray(value.suppressedFindings) &&
    value.suppressedFindings.every(validSuppressedFinding) &&
    value.suppressedFindingCount === value.suppressedFindings.length
  );
}

function validLedgerTransitions(value: Record<string, unknown>): boolean {
  if (value.ledgerTransitions === undefined) return true;
  return (
    Array.isArray(value.ledgerTransitions) && value.ledgerTransitions.every(validLedgerTransition)
  );
}

function validFindingLists(value: Record<string, unknown>): boolean {
  return (
    validMaterialFindingList(value) &&
    validSuppressedFindingList(value) &&
    validLedgerTransitions(value)
  );
}

// oxlint-disable-next-line complexity
function validOutcome(value: unknown): value is SafeReviewOutcomeRecord {
  if (
    !isJsonObject(value) ||
    typeof value.type !== "string" ||
    typeof value.diagnosticPresent !== "boolean"
  ) {
    return false;
  }
  if (!validCounts(value) || !validFindingLists(value)) return false;
  const completed = value.type === "clean" || value.type === "findings";
  if (completed !== (value.coverage === "completed_permitted")) return false;
  if (!completed && value.coverage !== undefined) return false;
  if (
    value.type === "timeout"
      ? !positiveInteger(value.timeoutSeconds)
      : value.timeoutSeconds !== undefined
  ) {
    return false;
  }
  switch (value.type) {
    case "clean":
      return (
        value.materialFindingCount === 0 &&
        Array.isArray(value.materialFindings) &&
        value.materialFindings.length === 0
      );
    case "findings":
      return positiveInteger(value.materialFindingCount) && Array.isArray(value.materialFindings);
    case "policy_skip":
    case "unsupported_change":
    case "configuration_failure":
      return value.materialFindingCount === undefined && value.materialFindings === undefined;
    case "abstention":
    case "partial_coverage":
    case "provider_failure":
    case "budget_limit":
    case "resource_limit":
    case "timeout":
    case "internal_failure":
      return true;
    default:
      return false;
  }
}

function closedFinding(value: SafeFindingOutcomeRecord): SafeFindingOutcomeRecord {
  return {
    fingerprint: value.fingerprint,
    lifecycleState: value.lifecycleState,
    verificationState: value.verificationState,
    verificationLimitationCount: value.verificationLimitationCount,
    evidenceCount: value.evidenceCount,
  };
}

function closedTransition(value: SafeLedgerTransitionRecord): SafeLedgerTransitionRecord {
  return {
    fingerprint: value.fingerprint,
    lifecycleState: value.lifecycleState,
    ...(value.previousLifecycleState === undefined
      ? {}
      : { previousLifecycleState: value.previousLifecycleState }),
    changed: value.changed,
  };
}

// oxlint-disable-next-line complexity
function closedOutcome(value: SafeReviewOutcomeRecord): SafeReviewOutcomeRecord {
  return {
    type: value.type,
    ...(value.coverage === undefined ? {} : { coverage: value.coverage }),
    ...(value.timeoutSeconds === undefined ? {} : { timeoutSeconds: value.timeoutSeconds }),
    ...(value.materialFindingCount === undefined
      ? {}
      : { materialFindingCount: value.materialFindingCount }),
    ...(value.advisorySuggestionCount === undefined
      ? {}
      : { advisorySuggestionCount: value.advisorySuggestionCount }),
    ...(value.validationAttemptCount === undefined
      ? {}
      : { validationAttemptCount: value.validationAttemptCount }),
    ...(value.coverageGapCount === undefined ? {} : { coverageGapCount: value.coverageGapCount }),
    ...(value.executionArtifactCount === undefined
      ? {}
      : { executionArtifactCount: value.executionArtifactCount }),
    ...(value.suppressedFindingCount === undefined
      ? {}
      : { suppressedFindingCount: value.suppressedFindingCount }),
    ...(value.materialFindings === undefined
      ? {}
      : { materialFindings: value.materialFindings.map(closedFinding) }),
    ...(value.suppressedFindings === undefined
      ? {}
      : {
          suppressedFindings: value.suppressedFindings.map(({ fingerprint }) => ({ fingerprint })),
        }),
    ...(value.ledgerTransitions === undefined
      ? {}
      : { ledgerTransitions: value.ledgerTransitions.map(closedTransition) }),
    diagnosticPresent: value.diagnosticPresent,
  };
}

function closedRevision(
  value: PullRequestRevisionContext | undefined,
): PullRequestRevisionContext | undefined {
  if (value === undefined) return undefined;
  return {
    pullRequest: {
      repository: value.pullRequest.repository,
      number: value.pullRequest.number,
      baseSha: value.pullRequest.baseSha,
      headSha: value.pullRequest.headSha,
    },
    ...(value.mergeBaseSha === undefined ? {} : { mergeBaseSha: value.mergeBaseSha }),
  };
}

function closedAttempt(value: SafeValidationAttemptRecord): SafeValidationAttemptRecord {
  return {
    commandIndex: value.commandIndex,
    commandHash: value.commandHash,
    timeoutSeconds: value.timeoutSeconds,
    status: value.status,
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    truncated: value.truncated,
    limitation: value.limitation,
  };
}

// oxlint-disable-next-line complexity
export function parseReviewRunRecord(value: unknown): ReviewRunRecord {
  requireJsonVersion(value, REVIEW_RUN_RECORD_VERSION, "Review run record");
  if (
    typeof value.runId !== "string" ||
    value.runId.length === 0 ||
    typeof value.recordedAt !== "string" ||
    !Number.isFinite(Date.parse(value.recordedAt)) ||
    typeof value.engineVersion !== "string" ||
    value.engineVersion.length === 0 ||
    !validRevision(value.revision) ||
    !trustClasses.has(value.trustClass as TrustClassification["class"]) ||
    (value.policyStatus !== "valid" && value.policyStatus !== "unavailable") ||
    (value.policyHash !== null &&
      (typeof value.policyHash !== "string" || !hashPattern.test(value.policyHash))) ||
    (value.policyStatus === "valid" && value.policyHash === null) ||
    (value.policyStatus === "valid" ? !validBudget(value.budget) : value.budget !== undefined) ||
    !Array.isArray(value.providerModels) ||
    !value.providerModels.every(
      (metadata) =>
        isJsonObject(metadata) &&
        [metadata.role, metadata.provider, metadata.model].every(validSafeMetadata),
    ) ||
    !Array.isArray(value.validationAttempts) ||
    !value.validationAttempts.every(validValidationAttempt) ||
    !validOutcome(value.finalOutcome)
  ) {
    throw new Error("Review run record is not supported.");
  }
  const parsed = value as unknown as ReviewRunRecord;
  return {
    version: REVIEW_RUN_RECORD_VERSION,
    runId: parsed.runId,
    recordedAt: parsed.recordedAt,
    engineVersion: parsed.engineVersion,
    ...(parsed.revision === undefined ? {} : { revision: closedRevision(parsed.revision) }),
    trustClass: parsed.trustClass,
    policyStatus: parsed.policyStatus,
    policyHash: parsed.policyHash,
    providerModels: parsed.providerModels.map(({ role, provider, model }) => ({
      role,
      provider,
      model,
    })),
    ...(parsed.budget === undefined
      ? {}
      : {
          budget: {
            reviewTimeoutSeconds: parsed.budget.reviewTimeoutSeconds,
            maxFindings: parsed.budget.maxFindings,
            validationCommandCount: parsed.budget.validationCommandCount,
          },
        }),
    validationAttempts: parsed.validationAttempts.map(closedAttempt),
    finalOutcome: closedOutcome(parsed.finalOutcome),
  };
}
