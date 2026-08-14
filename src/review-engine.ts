/* oxlint-disable max-lines */
import { randomUUID } from "node:crypto";

import {
  reconcileFindingLedger,
  type FindingDiscussionEvent,
  type FindingDispositionState,
  type FindingLedger,
  type LedgerFindingSnapshot,
} from "./finding-ledger.js";
import type { PullRequestPersistenceKey, ReviewPersistenceStore } from "./persistence.js";
import {
  createReviewRunRecord,
  REVIEW_RUN_RECORD_VERSION,
  safeReviewOutcome,
} from "./review-run-record.js";
import {
  type PolicySource,
  type ProjectPolicy,
  type ProjectPolicyInput,
  type ReviewRole,
  parseProjectPolicy,
} from "./project-policy.js";
import {
  type DiffowlCredentials,
  type ResolvedRole,
  type ResolvedRoles,
  type ReviewedPullRequest,
  type RoleExecutionArtifact,
  type RoleExecutor,
  type VerificationAdapter,
  type VerificationContext,
  type SuppressedFinding,
  orchestrateReviewRoles,
  orchestrationPlan,
} from "./review-orchestration.js";
import type { ReviewOutcome } from "./review-outcome.js";
import { createRunCellRoleExecutor } from "./runcell-orchestration.js";
import type { TrustClassification } from "./trust.js";

export type {
  PolicySource,
  ProjectPolicy,
  ProjectPolicyInput,
  ReviewRole,
  RoleProfile,
  RoleProfiles,
} from "./project-policy.js";
export { PROJECT_POLICY_CEILINGS, PROJECT_POLICY_PATH } from "./project-policy.js";
export type {
  AdvisorySuggestion,
  CandidateDraft,
  CandidateLocation,
  FindingLifecycleState,
  FindingVerificationState,
  MaterialFinding,
  ChallengerAssessment,
  DiffowlAuthBlob,
  DiffowlCredentials,
  DiffowlCredentialStore,
  DiffowlStoredCredential,
  ExecutionFile,
  ExecutionSnapshot,
  OrchestrationPlan,
  OrchestrationStep,
  ReviewedPullRequest,
  RoleExecutionArtifact,
  RoleExecutionEvent,
  RoleExecutionRequest,
  RoleExecutionResult,
  RoleOutput,
  ValidationAttempt,
  ValidationExecutionRequest,
  VerificationAdapter,
  VerificationContext,
  VerificationEvidence,
  VerifierAssessment,
} from "./review-orchestration.js";
export type {
  PublisherValidation,
  TrustCapabilities,
  TrustClassification,
  TrustContext,
} from "./trust.js";
export { classifyTrust } from "./trust.js";
export type { ReviewOutcome, ReviewRunMetadata } from "./review-outcome.js";
export {
  SYNTHETIC_EVALUATION_CORPUS_VERSION,
  evaluateSyntheticCorpus,
} from "./synthetic-evaluation.js";
export type {
  ExpectedSyntheticFinding,
  OutcomeCategory,
  ReleaseReportCard,
  SyntheticCaseReport,
  SyntheticEvaluationCase,
  SyntheticEvaluationCaseKind,
  SyntheticEvaluationCorpus,
  SyntheticEvaluationDiagnosticsInput,
  SyntheticEvaluationObservation,
  SyntheticFindingResult,
  SyntheticReportTokenDiagnostics,
  UnexpectedSyntheticFinding,
} from "./synthetic-evaluation.js";
export {
  REQUIRED_V1_THREAT_TEST_IDS,
  createV1ReleaseReportCard,
  evaluateV1ReleaseGate,
} from "./release-gate.js";
export type {
  ThreatTestResult,
  V1ReleaseGateResult,
  V1ReleaseReportCard,
  V1ThreatTestId,
} from "./release-gate.js";
export {
  createFindingFingerprint,
  parseFindingFingerprint,
  FINDING_FINGERPRINT_VERSION,
} from "./finding-fingerprint.js";
export type {
  FindingFingerprint,
  FindingFingerprintInput,
  EvidenceAnchorInput,
  LocationContextInput,
} from "./finding-fingerprint.js";
export {
  reconcileFindingLedger,
  parseFindingLedger,
  FINDING_LEDGER_VERSION,
} from "./finding-ledger.js";
export {
  findingIdentityMarker,
  parseFindingDiscussionEvent,
  recognizeFindingDiscussionCommands,
} from "./finding-discussion.js";
export type {
  FindingLedger,
  FindingLedgerEntry,
  FindingLedgerReconciliationInput,
  FindingDiscussionEvent,
  FindingDispositionState,
  LedgerFindingSnapshot,
} from "./finding-ledger.js";
export type {
  FindingDiscussionCommand,
  FindingDiscussionComment,
  FindingDiscussionEffects,
} from "./finding-discussion.js";
export { GitReviewPersistenceStore } from "./git-state-persistence.js";
export { FileSystemReviewPersistenceStore } from "./persistence.js";
export type {
  PullRequestPersistenceKey,
  ReviewPersistenceStore,
  ReviewPersistenceTransaction,
} from "./persistence.js";
export {
  createReviewRunRecord,
  parseReviewRunRecord,
  REVIEW_RUN_RECORD_VERSION,
} from "./review-run-record.js";
export type {
  ReviewRunRecord,
  SafeReviewOutcomeRecord,
  SafeProviderModelMetadata,
  SafeValidationAttemptRecord,
} from "./review-run-record.js";

export interface PullRequestInput extends ReviewedPullRequest {
  diff: string;
  policy: ProjectPolicyInput;
  trust: TrustClassification;
}

export interface ReviewDependencies {
  credentialProfiles?: Readonly<Record<string, DiffowlCredentials>> | undefined;
  executeRole?: RoleExecutor | undefined;
  verificationAdapter?: VerificationAdapter | undefined;
  persistence?: ReviewPersistenceStore | undefined;
  runId?: string | undefined;
  engineVersion?: string | undefined;
  recordedAt?: () => string;
  mergeBaseSha?: string | undefined;
  obsoleteFingerprints?: readonly string[] | undefined;
  resolvedFingerprints?: readonly string[] | undefined;
  findingDispositions?: Readonly<Record<string, FindingDispositionState>> | undefined;
  reassessedFingerprints?: readonly string[] | undefined;
  findingDiscussionEvents?: readonly FindingDiscussionEvent[] | undefined;
}

const defaultCredentialProfiles = { default: { type: "env" as const } };
const defaultExecuteRole = createRunCellRoleExecutor();
export const unavailableVerificationAdapter: VerificationAdapter = {
  readRepositoryFile: async () => undefined,
  executeValidation: async () => ({
    status: "error",
    stdout: "",
    stderr: "",
    truncated: false,
    limitation: "No validation execution adapter was configured.",
  }),
};

function pullRequestFrom(input: PullRequestInput): ReviewedPullRequest {
  return {
    repository: input.repository,
    number: input.number,
    baseSha: input.baseSha,
    headSha: input.headSha,
  };
}

function partialCoverageReason(trust: TrustClassification): string {
  return trust.class === "untrusted_pull_request"
    ? "Trust restrictions permit static review only; validation commands are denied."
    : "The tracer path does not analyze changes yet.";
}

function configurationFailure(input: PullRequestInput, reason: string): ReviewOutcome {
  return {
    type: "configuration_failure",
    pullRequest: pullRequestFrom(input),
    policySource: input.policy.source,
    reason,
    trust: input.trust,
  };
}

function resolveRole(
  name: ReviewRole,
  policy: ProjectPolicy,
  credentialProfiles: Readonly<Record<string, DiffowlCredentials>>,
): ResolvedRole | string {
  const profile = policy.roleProfiles[name];
  const credentials = Object.hasOwn(credentialProfiles, profile.credentialProfile)
    ? credentialProfiles[profile.credentialProfile]
    : undefined;
  return credentials === undefined
    ? `Credential profile "${profile.credentialProfile}" required by ${name} role is missing.`
    : { profile, credentials };
}

function resolveRoles(
  policy: ProjectPolicy,
  credentialProfiles: Readonly<Record<string, DiffowlCredentials>>,
): ResolvedRoles | string {
  const reviewer = resolveRole("reviewer", policy, credentialProfiles);
  if (typeof reviewer === "string") return reviewer;
  const challenger = resolveRole("challenger", policy, credentialProfiles);
  if (typeof challenger === "string") return challenger;
  const verifier = resolveRole("verifier", policy, credentialProfiles);
  if (typeof verifier === "string") return verifier;
  return { reviewer, challenger, verifier };
}

async function executeWithinTimeout(
  execution: () => ReturnType<typeof orchestrateReviewRoles>,
  timeoutSeconds: number,
  controller: AbortController,
): Promise<
  | Awaited<ReturnType<typeof orchestrateReviewRoles>>
  | { type: "timeout" }
  | { type: "internal_failure"; reason: string }
> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ type: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ type: "timeout" });
    }, timeoutSeconds * 1_000);
  });
  try {
    return await Promise.race([execution(), timeout]);
  } catch (error) {
    return {
      type: "internal_failure",
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function incompleteCoverageReason(verification: VerificationContext): string | undefined {
  return verification.coverageGaps.length === 0
    ? undefined
    : `Review coverage is partial: ${verification.coverageGaps.join(" ")}`;
}

function ledgerSnapshot(finding: {
  fingerprint: { value: string };
  summary: string;
  location?: { path: string } | undefined;
  locationPath?: string | undefined;
}): LedgerFindingSnapshot {
  return {
    fingerprint: finding.fingerprint.value,
    summary: finding.summary,
    locationPath: finding.location?.path ?? finding.locationPath,
  };
}

function validationAttempts(
  outcome: ReviewOutcome,
  verification?: VerificationContext | undefined,
): VerificationContext["validationAttempts"] {
  return "verification" in outcome && outcome.verification !== undefined
    ? outcome.verification.validationAttempts
    : (verification?.validationAttempts ?? []);
}

function completedForLedger(outcome: ReviewOutcome): boolean {
  return (
    (outcome.type === "clean" || outcome.type === "findings") &&
    outcome.coverage === "completed_permitted"
  );
}

function findingsForLedger(outcome: ReviewOutcome): LedgerFindingSnapshot[] {
  return "materialFindings" in outcome && outcome.materialFindings !== undefined
    ? outcome.materialFindings.map(ledgerSnapshot)
    : [];
}

function suppressedForLedger(findings: SuppressedFinding[]): LedgerFindingSnapshot[] {
  return findings.map(ledgerSnapshot);
}

function ledgerTransitions(previousLedger: FindingLedger | undefined, ledger: FindingLedger) {
  const previousLifecycle = new Map(
    (previousLedger?.entries ?? []).map((entry) => [entry.fingerprint, entry.lifecycleState]),
  );
  return ledger.entries.map(({ fingerprint, lifecycleState }) => ({
    fingerprint,
    lifecycleState,
    previousLifecycleState: previousLifecycle.get(fingerprint),
    changed: previousLifecycle.get(fingerprint) !== lifecycleState,
  }));
}

function persistenceFailureOutcome(
  input: PullRequestInput,
  outcome: ReviewOutcome,
  error?: unknown,
): ReviewOutcome {
  const detail = error instanceof Error ? error.message : "";
  if (detail.startsWith("GitHub Finding state is not configured correctly:")) {
    return configurationFailure(input, detail);
  }
  if ("policy" in outcome) {
    return {
      type: "internal_failure",
      pullRequest: pullRequestFrom(input),
      policy: outcome.policy,
      reason: "Review persistence failed; the result cannot be treated as clean.",
      trust: input.trust,
    };
  }
  return {
    type: "configuration_failure",
    pullRequest: pullRequestFrom(input),
    policySource: input.policy.source,
    reason: "Review persistence failed; the result was not recorded.",
    trust: input.trust,
  };
}

// oxlint-disable-next-line max-lines-per-function
async function persistOutcome(
  input: PullRequestInput,
  outcome: ReviewOutcome,
  suppressedFindings: SuppressedFinding[],
  dependencies: ReviewDependencies,
  verification?: VerificationContext | undefined,
): Promise<ReviewOutcome> {
  if (dependencies.persistence === undefined) return outcome;
  const runId = dependencies.runId ?? randomUUID();
  const key: PullRequestPersistenceKey = {
    repository: input.repository,
    pullRequestNumber: input.number,
  };
  try {
    return await dependencies.persistence.withTransaction(key, async (transaction) => {
      const previousLedger = await transaction.loadLedger();
      const ledger = reconcileFindingLedger({
        previous: previousLedger,
        runId,
        completion: completedForLedger(outcome) ? "completed_permitted" : "incomplete",
        materialFindings: findingsForLedger(outcome),
        suppressedFindings: suppressedForLedger(suppressedFindings),
        dispositions: dependencies.findingDispositions,
        obsoleteFingerprints: dependencies.obsoleteFingerprints,
        resolvedFingerprints: dependencies.resolvedFingerprints,
        reassessments: dependencies.reassessedFingerprints,
        discussionEvents: dependencies.findingDiscussionEvents,
      });
      const transitions = ledgerTransitions(previousLedger, ledger);
      const lifecycle = new Map(
        ledger.entries.map((entry) => [entry.fingerprint, entry.lifecycleState]),
      );
      if ("materialFindings" in outcome && outcome.materialFindings !== undefined) {
        for (const finding of outcome.materialFindings) {
          finding.lifecycleState =
            lifecycle.get(finding.fingerprint.value) ?? finding.lifecycleState;
        }
      }
      const record = createReviewRunRecord({
        runId,
        recordedAt: dependencies.recordedAt?.() ?? new Date().toISOString(),
        engineVersion: dependencies.engineVersion ?? "0.1.0",
        revision: { pullRequest: pullRequestFrom(input), mergeBaseSha: dependencies.mergeBaseSha },
        trust: input.trust,
        unavailablePolicyContents: input.policy.contents,
        validationAttempts: validationAttempts(outcome, verification),
        finalOutcome: outcome,
        suppressedFindings,
        ledgerTransitions: transitions,
      });
      await transaction.saveLedger(ledger);
      await transaction.saveRunRecord(record);
      return {
        ...outcome,
        run: {
          runId,
          recordVersion: REVIEW_RUN_RECORD_VERSION,
          outcome: safeReviewOutcome(outcome, {
            suppressedFindings,
            ledgerTransitions: transitions,
          }),
          ledgerTransitions: transitions.map(({ fingerprint, lifecycleState }) => ({
            fingerprint,
            lifecycleState,
          })),
        },
      };
    });
  } catch (error) {
    return persistenceFailureOutcome(input, outcome, error);
  }
}

function completedReviewOutcome(
  configured: {
    pullRequest: ReviewedPullRequest;
    trust: TrustClassification;
    policy: { source: PolicySource; effective: ProjectPolicy };
  },
  execution: Extract<Awaited<ReturnType<typeof orchestrateReviewRoles>>, { type: "completed" }>,
): ReviewOutcome {
  const reviewDetails = {
    materialFindings: execution.materialFindings,
    advisorySuggestions: execution.advisorySuggestions,
    verification: execution.verification,
    orchestrationPlan: orchestrationPlan(configured.policy.effective),
    executionArtifacts: execution.executionArtifacts,
  };
  const reason = incompleteCoverageReason(execution.verification);
  if (reason !== undefined)
    return { ...configured, ...reviewDetails, type: "partial_coverage", reason };
  if (execution.materialFindings.length === 0) {
    return {
      ...configured,
      ...reviewDetails,
      type: "clean",
      coverage: "completed_permitted",
      materialFindings: [],
    };
  }
  const completed = { ...configured, ...reviewDetails, coverage: "completed_permitted" as const };
  const [firstFinding, ...remainingFindings] = execution.materialFindings;
  return {
    ...completed,
    type: "findings",
    materialFindings: [firstFinding!, ...remainingFindings],
  };
}

// The public seam keeps policy, trust, timeout, and orchestration ordering visible.
// oxlint-disable-next-line max-lines-per-function, complexity
export async function runReview(
  input: PullRequestInput,
  dependencies: ReviewDependencies = {},
): Promise<ReviewOutcome> {
  const result = parseProjectPolicy(input.policy.contents);
  if (!result.valid) {
    return persistOutcome(input, configurationFailure(input, result.reason), [], dependencies);
  }
  const configured = {
    pullRequest: pullRequestFrom(input),
    trust: input.trust,
    policy: { source: input.policy.source, effective: result.policy },
  };
  const providerCredentialsAllowed =
    input.trust.capabilities.secrets === "provider_credentials_only" ||
    input.trust.capabilities.secrets === "local_user_authorized";
  if (!providerCredentialsAllowed) {
    return persistOutcome(
      input,
      {
        ...configured,
        type: "partial_coverage",
        reason: partialCoverageReason(input.trust),
      },
      [],
      dependencies,
    );
  }
  const roles = resolveRoles(
    result.policy,
    dependencies.credentialProfiles ?? defaultCredentialProfiles,
  );
  if (typeof roles === "string") {
    return persistOutcome(input, configurationFailure(input, roles), [], dependencies);
  }
  const controller = new AbortController();
  const executionArtifacts: RoleExecutionArtifact[] = [];
  const verification: VerificationContext = {
    evidenceCatalog: [],
    validationAttempts: [],
    limitations: [],
    coverageGaps: [],
  };
  const execution = await executeWithinTimeout(
    () =>
      orchestrateReviewRoles(
        pullRequestFrom(input),
        input.diff,
        result.policy,
        roles,
        dependencies.executeRole ?? defaultExecuteRole,
        controller.signal,
        dependencies.verificationAdapter ?? unavailableVerificationAdapter,
        input.trust.capabilities.validationCommands !== "denied",
        executionArtifacts,
        verification,
      ),
    result.policy.limits.reviewTimeoutSeconds,
    controller,
  );
  if (execution.type === "timeout") {
    return persistOutcome(
      input,
      {
        ...configured,
        type: "timeout",
        timeoutSeconds: result.policy.limits.reviewTimeoutSeconds,
        executionArtifacts: [...executionArtifacts],
      },
      [],
      dependencies,
      verification,
    );
  }
  const outcome: ReviewOutcome =
    execution.type === "internal_failure"
      ? { ...configured, ...execution }
      : execution.type === "completed"
        ? completedReviewOutcome(configured, execution)
        : { ...configured, ...execution };
  const suppressed = "suppressedFindings" in execution ? execution.suppressedFindings : [];
  return persistOutcome(
    input,
    outcome,
    suppressed,
    dependencies,
    "verification" in execution ? execution.verification : undefined,
  );
}
