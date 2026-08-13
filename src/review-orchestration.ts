/* oxlint-disable max-lines */
import { minimatch } from "minimatch";

import { createFindingFingerprint, type FindingFingerprint } from "./finding-fingerprint.js";
import {
  PROJECT_POLICY_CEILINGS,
  type ProjectPolicy,
  type ReviewRole,
  type RoleProfile,
} from "./project-policy.js";
import { truncateUtf8 } from "./utf8.js";

export type DiffowlStoredCredential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires: number;
      [key: string]: unknown;
    };

export type DiffowlAuthBlob = Record<string, DiffowlStoredCredential>;

export interface DiffowlCredentialStore {
  withLock<T>(
    key: string,
    operation: (
      current: DiffowlAuthBlob | undefined,
    ) => Promise<{ result: T; next?: DiffowlAuthBlob }>,
  ): Promise<T>;
}

export type DiffowlCredentials =
  | "local"
  | { type: "local"; agentDir?: string; allowInProduction?: boolean }
  | { type: "env" }
  | { type: "agentDir"; path: string }
  | { type: "shared"; key: string; store: DiffowlCredentialStore };

export interface ReviewedPullRequest {
  repository: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export interface CandidateLocation {
  path: string;
  line?: number | undefined;
}

export interface CandidateFingerprintContext {
  claimKind?: string | undefined;
  affectedArea?: string | undefined;
  policyOrCapability?: string | undefined;
  symbol?: string | undefined;
  api?: string | undefined;
  configKey?: string | undefined;
  behavior?: string | undefined;
}

export interface CandidateDraft {
  summary: string;
  location: CandidateLocation;
  impact: string;
  evidence: string[];
  fingerprintContext?: CandidateFingerprintContext | undefined;
}

export type VerificationEvidence =
  | { id: string; type: "scoped_diff"; path: string; content: string; truncated: boolean }
  | { id: string; type: "repository_file"; path: string; content: string; truncated: boolean }
  | { id: string; type: "validation"; commandIndex: number; content: string; truncated: boolean };

export interface ValidationAttempt {
  commandIndex: number;
  argv: string[];
  timeoutSeconds: number;
  status: "passed" | "failed" | "timed_out" | "aborted" | "error";
  exitCode?: number | undefined;
  stdout: string;
  stderr: string;
  truncated: boolean;
  limitation?: string | undefined;
}

export type FindingLifecycleState =
  | "new"
  | "persisting"
  | "resolved"
  | "obsolete"
  | "rebutted"
  | "accepted"
  | "suppressed";

export type FindingVerificationState =
  | { type: "verified"; explanation: string; limitations: [] }
  | { type: "verified_with_limitations"; explanation: string; limitations: string[] };

export interface MaterialFinding {
  fingerprint: FindingFingerprint;
  summary: string;
  location: CandidateLocation;
  impact: string;
  evidence: VerificationEvidence[];
  lifecycleState: FindingLifecycleState;
  verificationState: FindingVerificationState;
}

export interface AdvisorySuggestion {
  summary: string;
  rationale: string;
  location?: CandidateLocation | undefined;
}

export type OrchestrationStep =
  | { role: "reviewer"; purpose: "generate_candidates" }
  | { role: "challenger"; purpose: "challenge_candidates" }
  | { role: "verifier"; purpose: "verify_candidates" };

export interface OrchestrationPlan {
  maxCandidateFindings: number;
  steps: OrchestrationStep[];
}

export interface RoleExecutionEvent {
  type: "tool_call" | "tool_result" | "file_change" | "repair" | "finish" | "error";
  detail: unknown;
}

export interface ExecutionSnapshot {
  version: 1;
  files: Array<{ path: string; data: string }>;
}

export interface ExecutionFile {
  path: string;
  change: "create" | "modify";
  bytes: Uint8Array;
}

export interface RoleExecutionArtifact {
  role: ReviewRole;
  snapshot: ExecutionSnapshot;
  events: RoleExecutionEvent[];
  files: ExecutionFile[];
  sessionId: string;
  finishReason: string;
}

export interface ChallengerAssessment {
  candidateIndex: number;
  verdict: "support" | "reject" | "downgrade";
  reason: string;
}

export interface VerifierAssessment {
  candidateIndex: number;
  disposition: "material" | "advisory" | "suppress" | "abstain";
  evidenceIds: string[];
  explanation: string;
  limitations: string[];
}

export type RoleOutput =
  | {
      role: "reviewer";
      candidateFindings: CandidateDraft[];
      advisorySuggestions: AdvisorySuggestion[];
    }
  | { role: "challenger"; assessments: ChallengerAssessment[] }
  | { role: "verifier"; assessments: VerifierAssessment[] };

export interface VerificationContext {
  evidenceCatalog: VerificationEvidence[];
  validationAttempts: ValidationAttempt[];
  limitations: string[];
  coverageGaps: string[];
}

export interface RepositoryEvidenceRequest {
  repository: string;
  headSha: string;
  path: string;
  maxBytes: number;
  signal: AbortSignal;
}

export interface ValidationExecutionRequest {
  argv: string[];
  timeoutSeconds: number;
  maxOutputBytes: number;
  signal: AbortSignal;
}

export interface VerificationAdapter {
  readRepositoryFile(
    request: RepositoryEvidenceRequest,
  ): Promise<{ content: string; truncated: boolean } | undefined>;
  executeValidation(
    request: ValidationExecutionRequest,
  ): Promise<Omit<ValidationAttempt, "commandIndex" | "argv" | "timeoutSeconds">>;
}

export interface RoleExecutionRequest {
  pullRequest: ReviewedPullRequest;
  diff: string;
  step: OrchestrationStep;
  profile: RoleProfile;
  credentials: DiffowlCredentials;
  roleInput: unknown;
  maxCandidateFindings: number;
  signal: AbortSignal;
}

export type RoleExecutionResult =
  | { type: "completed"; output: RoleOutput; artifact: RoleExecutionArtifact }
  | {
      type: "provider_failure" | "budget_limit" | "resource_limit";
      reason: string;
      artifact?: RoleExecutionArtifact | undefined;
    };

export type RoleExecutor = (request: RoleExecutionRequest) => Promise<RoleExecutionResult>;

export type ResolvedRole = { profile: RoleProfile; credentials: DiffowlCredentials };
export type ResolvedRoles = Record<ReviewRole, ResolvedRole>;

export interface SuppressedFinding {
  fingerprint: FindingFingerprint;
  summary: string;
  locationPath: string;
}

export type OrchestrationExecutionResult =
  | {
      type: "completed";
      materialFindings: MaterialFinding[];
      suppressedFindings: SuppressedFinding[];
      advisorySuggestions: AdvisorySuggestion[];
      verification: VerificationContext;
      executionArtifacts: RoleExecutionArtifact[];
    }
  | {
      type: "abstention";
      reason: string;
      materialFindings: MaterialFinding[];
      suppressedFindings: SuppressedFinding[];
      advisorySuggestions: AdvisorySuggestion[];
      verification: VerificationContext;
      executionArtifacts: RoleExecutionArtifact[];
    }
  | {
      type: "provider_failure" | "budget_limit" | "resource_limit";
      reason: string;
      verification: VerificationContext;
      executionArtifacts: RoleExecutionArtifact[];
    };

export function orchestrationPlan(policy: ProjectPolicy): OrchestrationPlan {
  return {
    maxCandidateFindings: policy.limits.maxFindings,
    steps: [
      { role: "reviewer", purpose: "generate_candidates" },
      { role: "challenger", purpose: "challenge_candidates" },
      { role: "verifier", purpose: "verify_candidates" },
    ],
  };
}

const gitEscapeBytes: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

function decodeQuotedGitPath(value: string): string | undefined {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      bytes.push(...encoder.encode(character));
      continue;
    }
    const escape = value[++index];
    if (escape === undefined) return undefined;
    const octal = /^[0-7]{1,3}/.exec(value.slice(index));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += octal[0].length - 1;
      continue;
    }
    const escapedByte = gitEscapeBytes[escape];
    if (escapedByte === undefined) return undefined;
    bytes.push(escapedByte);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}

function decodeGitPath(value: string): string | undefined {
  try {
    const path = value.startsWith('"') ? decodeQuotedGitPath(value) : value;
    return path?.startsWith("b/") === true ? path.slice(2) : undefined;
  } catch {
    return undefined;
  }
}

function diffPath(section: string): string | undefined {
  const header = /^diff --git (?:"(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|\S+)$/m.exec(section);
  return header?.[1] === undefined ? undefined : decodeGitPath(header[1]);
}

function pathInScope(path: string, policy: ProjectPolicy): boolean {
  const included = policy.scope.includePaths.some((pattern) =>
    minimatch(path, pattern, { dot: true }),
  );
  const excluded = policy.scope.excludePaths.some((pattern) =>
    minimatch(path, pattern, { dot: true }),
  );
  return included && !excluded;
}

function scopedDiff(diff: string, policy: ProjectPolicy): string {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const path = diffPath(section);
      return path !== undefined && pathInScope(path, policy);
    })
    .join("");
}

function challengedCandidates(
  candidates: CandidateDraft[],
  advisories: AdvisorySuggestion[],
  assessments: ChallengerAssessment[],
): { candidates: CandidateDraft[]; advisories: AdvisorySuggestion[] } {
  const byIndex = new Map(assessments.map((assessment) => [assessment.candidateIndex, assessment]));
  const surviving: CandidateDraft[] = [];
  const updatedAdvisories = [...advisories];
  candidates.forEach((candidate, index) => {
    const assessment = byIndex.get(index);
    if (assessment?.verdict === "reject") return;
    if (assessment?.verdict === "downgrade") {
      updatedAdvisories.push({
        summary: candidate.summary,
        rationale: assessment.reason,
        location: candidate.location,
      });
      return;
    }
    surviving.push(candidate);
  });
  return { candidates: surviving, advisories: updatedAdvisories };
}

function validVerifierAssessment(
  value: VerifierAssessment | undefined,
): value is VerifierAssessment {
  if (value === undefined || !Number.isInteger(value.candidateIndex)) return false;
  if (
    !Array.isArray(value.evidenceIds) ||
    !value.evidenceIds.every((id) => typeof id === "string")
  ) {
    return false;
  }
  if (typeof value.explanation !== "string" || value.explanation.length === 0) return false;
  if (!Array.isArray(value.limitations)) return false;
  return value.limitations.every(
    (limitation) => typeof limitation === "string" && limitation.length > 0,
  );
}

interface VerifiedCandidates {
  findings: MaterialFinding[];
  suppressed: SuppressedFinding[];
  advisories: AdvisorySuggestion[];
  abstentionReasons: string[];
  unassessed: number;
}

// oxlint-disable-next-line complexity
function candidateFingerprint(candidate: CandidateDraft): FindingFingerprint {
  const details = candidate.fingerprintContext;
  return createFindingFingerprint({
    claimKind: details?.claimKind ?? "material_problem",
    summary: candidate.summary,
    affectedArea: details?.affectedArea ?? candidate.location.path,
    evidenceAnchors: candidate.evidence.map((excerpt) => ({
      kind: "candidate_evidence",
      path: candidate.location.path,
      excerpt,
    })),
    policyOrCapability: details?.policyOrCapability ?? "material_review",
    location: {
      path: candidate.location.path,
      symbol: details?.symbol,
      api: details?.api,
      configKey: details?.configKey,
      behavior: details?.behavior,
    },
  });
}

// oxlint-disable-next-line max-lines-per-function
function verifiedCandidates(
  candidates: CandidateDraft[],
  advisories: AdvisorySuggestion[],
  assessments: VerifierAssessment[],
  context: VerificationContext,
): VerifiedCandidates {
  const catalog = new Map(context.evidenceCatalog.map((evidence) => [evidence.id, evidence]));
  const byIndex = new Map(assessments.map((assessment) => [assessment.candidateIndex, assessment]));
  const findings: MaterialFinding[] = [];
  const suppressed: SuppressedFinding[] = [];
  const updatedAdvisories = [...advisories];
  const abstentionReasons: string[] = [];
  let unassessed = 0;
  candidates.forEach((candidate, index) => {
    const assessment = byIndex.get(index);
    if (!validVerifierAssessment(assessment)) {
      unassessed += 1;
      return;
    }
    if (assessment.disposition === "abstain") {
      abstentionReasons.push(assessment.explanation);
      return;
    }
    if (assessment.disposition === "advisory") {
      updatedAdvisories.push({
        summary: candidate.summary,
        rationale: assessment.explanation,
        location: candidate.location,
      });
      return;
    }
    const fingerprint = candidateFingerprint(candidate);
    if (assessment.disposition === "suppress") {
      suppressed.push({
        fingerprint,
        summary: candidate.summary,
        locationPath: candidate.location.path,
      });
      return;
    }
    if (assessment.disposition !== "material") return;
    const usedEvidence = assessment.evidenceIds.flatMap((id) => {
      const evidence = catalog.get(id);
      return evidence === undefined ? [] : [evidence];
    });
    if (usedEvidence.length === 0) return;
    const limitations = [...context.limitations, ...assessment.limitations];
    findings.push({
      fingerprint,
      summary: candidate.summary,
      location: candidate.location,
      impact: candidate.impact,
      evidence: usedEvidence,
      lifecycleState: "new",
      verificationState:
        limitations.length === 0
          ? { type: "verified", explanation: assessment.explanation, limitations: [] }
          : {
              type: "verified_with_limitations",
              explanation: assessment.explanation,
              limitations,
            },
    });
  });
  const materialByFingerprint = new Map<string, MaterialFinding>();
  for (const finding of findings) {
    const key = finding.fingerprint.value;
    const existing = materialByFingerprint.get(key);
    if (existing === undefined) {
      materialByFingerprint.set(key, finding);
      continue;
    }
    const evidence = new Map(
      [...existing.evidence, ...finding.evidence].map((item) => [JSON.stringify(item), item]),
    );
    existing.evidence = [...evidence.values()];
  }
  const suppressedByFingerprint = new Map<string, SuppressedFinding>();
  for (const finding of suppressed) {
    if (!materialByFingerprint.has(finding.fingerprint.value)) {
      suppressedByFingerprint.set(finding.fingerprint.value, finding);
    }
  }
  return {
    findings: [...materialByFingerprint.values()],
    suppressed: [...suppressedByFingerprint.values()],
    advisories: updatedAdvisories,
    abstentionReasons,
    unassessed,
  };
}

async function repositoryEvidence(
  pullRequest: ReviewedPullRequest,
  candidates: CandidateDraft[],
  policy: ProjectPolicy,
  adapter: VerificationAdapter,
  signal: AbortSignal,
): Promise<{ evidence: VerificationEvidence[]; limitations: string[] }> {
  const evidence: VerificationEvidence[] = [];
  const limitations: string[] = [];
  const paths = [...new Set(candidates.map(({ location }) => location.path))];
  let evidenceIndex = 0;
  for (const path of paths) {
    if (!pathInScope(path, policy)) {
      limitations.push(`Repository evidence was not read for out-of-scope path ${path}.`);
      continue;
    }
    try {
      // Repository reads are sequential to keep adapter resource use bounded.
      // oxlint-disable-next-line no-await-in-loop
      const result = await adapter.readRepositoryFile({
        repository: pullRequest.repository,
        headSha: pullRequest.headSha,
        path,
        maxBytes: PROJECT_POLICY_CEILINGS.repositoryEvidenceBytes,
        signal,
      });
      if (result === undefined) {
        limitations.push(
          `Repository evidence was unavailable for ${path} at ${pullRequest.headSha}.`,
        );
        continue;
      }
      const bounded = truncateUtf8(result.content, PROJECT_POLICY_CEILINGS.repositoryEvidenceBytes);
      if (bounded.content.length === 0) {
        limitations.push(`Repository evidence for ${path} was empty.`);
        continue;
      }
      evidence.push({
        id: `repository-file:${evidenceIndex}`,
        type: "repository_file",
        path,
        content: bounded.content,
        truncated: result.truncated || bounded.truncated,
      });
      evidenceIndex += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      limitations.push(`Repository evidence failed for ${path}: ${reason}`);
    }
  }
  return { evidence, limitations };
}

async function executeValidationCommand(
  commandIndex: number,
  command: ProjectPolicy["verification"]["validationCommands"][number],
  adapter: VerificationAdapter,
  signal: AbortSignal,
): Promise<ValidationAttempt> {
  let result: Omit<ValidationAttempt, "commandIndex" | "argv" | "timeoutSeconds">;
  try {
    result = await adapter.executeValidation({
      argv: command.argv,
      timeoutSeconds: command.timeoutSeconds,
      maxOutputBytes: PROJECT_POLICY_CEILINGS.validationOutputBytes,
      signal,
    });
  } catch (error) {
    result = {
      status: signal.aborted ? "aborted" : "error",
      stdout: "",
      stderr: "",
      truncated: false,
      limitation: error instanceof Error ? error.message : String(error),
    };
  }
  const stdout = truncateUtf8(result.stdout, PROJECT_POLICY_CEILINGS.validationOutputBytes);
  const separatorBytes = stdout.content.length > 0 && result.stderr.length > 0 ? 1 : 0;
  const remaining = Math.max(
    0,
    PROJECT_POLICY_CEILINGS.validationOutputBytes -
      Buffer.byteLength(stdout.content) -
      separatorBytes,
  );
  const stderr = truncateUtf8(result.stderr, remaining);
  return {
    ...result,
    commandIndex,
    argv: [...command.argv],
    timeoutSeconds: command.timeoutSeconds,
    stdout: stdout.content,
    stderr: stderr.content,
    truncated: result.truncated || stdout.truncated || stderr.truncated,
  };
}

// oxlint-disable-next-line max-lines-per-function
async function validationEvidence(
  policy: ProjectPolicy,
  adapter: VerificationAdapter,
  allowed: boolean,
  signal: AbortSignal,
  attemptSink: (attempt: ValidationAttempt) => void,
): Promise<{
  evidence: VerificationEvidence[];
  attempts: ValidationAttempt[];
  limitations: string[];
}> {
  const commands = policy.verification.validationCommands;
  if (!allowed) {
    return {
      evidence: [],
      attempts: [],
      limitations:
        commands.length === 0
          ? []
          : ["Configured validation commands were denied by the trust class."],
    };
  }
  // Commands are selected by trusted policy. Parallel execution keeps the full-review timeout effective.
  const attempts = await Promise.all(
    commands.map(async (command, index) => {
      attemptSink({
        commandIndex: index,
        argv: [...command.argv],
        timeoutSeconds: command.timeoutSeconds,
        status: "aborted",
        stdout: "",
        stderr: "",
        truncated: false,
        limitation: "Validation was aborted before a final result was recorded.",
      });
      const attempt = await executeValidationCommand(index, command, adapter, signal);
      attemptSink(attempt);
      return attempt;
    }),
  );
  const evidence: VerificationEvidence[] = attempts.flatMap((attempt) => {
    const content = [attempt.stdout, attempt.stderr].filter(Boolean).join("\n");
    const evidentiaryStatus = ["passed", "failed", "timed_out"].includes(attempt.status);
    return evidentiaryStatus && content.length > 0
      ? [
          {
            id: `validation:${attempt.commandIndex}`,
            type: "validation" as const,
            commandIndex: attempt.commandIndex,
            content,
            truncated: attempt.truncated,
          },
        ]
      : [];
  });
  const limitations = attempts.flatMap((attempt) =>
    attempt.status === "passed"
      ? []
      : [
          attempt.limitation ??
            `Validation command ${attempt.commandIndex} completed with ${attempt.status}.`,
        ],
  );
  return { evidence, attempts, limitations };
}

async function gatherVerificationContext(
  pullRequest: ReviewedPullRequest,
  diff: string,
  candidates: CandidateDraft[],
  policy: ProjectPolicy,
  adapter: VerificationAdapter,
  validationCommandsAllowed: boolean,
  signal: AbortSignal,
  attemptSink: (attempt: ValidationAttempt) => void,
): Promise<VerificationContext> {
  const boundedDiff = truncateUtf8(
    scopedDiff(diff, policy),
    PROJECT_POLICY_CEILINGS.repositoryEvidenceBytes,
  );
  const repository = await repositoryEvidence(pullRequest, candidates, policy, adapter, signal);
  const validation = await validationEvidence(
    policy,
    adapter,
    validationCommandsAllowed,
    signal,
    attemptSink,
  );
  const diffEvidence: VerificationEvidence[] =
    boundedDiff.content.length === 0
      ? []
      : [
          {
            id: "scoped-diff",
            type: "scoped_diff",
            path: "pull-request.diff",
            content: boundedDiff.content,
            truncated: boundedDiff.truncated,
          },
        ];
  return {
    evidenceCatalog: [...diffEvidence, ...repository.evidence, ...validation.evidence],
    validationAttempts: validation.attempts,
    limitations: [
      ...(boundedDiff.content.length === 0
        ? ["The configured review scope produced an empty diff."]
        : []),
      ...repository.limitations,
      ...validation.limitations,
    ],
    coverageGaps: validation.limitations,
  };
}

interface OrchestrationState {
  candidates: CandidateDraft[];
  advisories: AdvisorySuggestion[];
  roleInput: unknown;
  assessments: VerifierAssessment[];
}

function applyRoleOutput(state: OrchestrationState, output: RoleOutput): void {
  if (output.role === "reviewer") {
    state.candidates = output.candidateFindings;
    state.advisories = output.advisorySuggestions;
    state.roleInput = output;
    return;
  }
  if (output.role === "challenger") {
    const challenged = challengedCandidates(state.candidates, state.advisories, output.assessments);
    state.candidates = challenged.candidates;
    state.advisories = challenged.advisories;
    state.roleInput = { candidateFindings: state.candidates };
    return;
  }
  state.assessments = output.assessments;
}

async function executeRoleSafely(
  executeRole: RoleExecutor,
  request: RoleExecutionRequest,
): Promise<RoleExecutionResult> {
  try {
    return await executeRole(request);
  } catch {
    return {
      type: "provider_failure",
      reason: `Provider execution failed for the ${request.step.role} role.`,
    };
  }
}

function abstentionResult(
  verified: VerifiedCandidates,
  verification: VerificationContext,
  executionArtifacts: RoleExecutionArtifact[],
): Extract<OrchestrationExecutionResult, { type: "abstention" }> | undefined {
  if (verified.abstentionReasons.length === 0 && verified.unassessed === 0) return undefined;
  const noun = verified.unassessed === 1 ? "candidate" : "candidates";
  const missingAssessment =
    verified.unassessed === 0
      ? []
      : [`The verifier did not assess ${verified.unassessed} surviving ${noun}.`];
  return {
    type: "abstention",
    reason: [...verified.abstentionReasons, ...missingAssessment].join(" "),
    materialFindings: verified.findings,
    suppressedFindings: verified.suppressed,
    advisorySuggestions: verified.advisories,
    verification,
    executionArtifacts,
  };
}

// Roles are deliberately sequential because each consumes the prior role's output.
// oxlint-disable-next-line max-lines-per-function, no-await-in-loop
export async function orchestrateReviewRoles(
  pullRequest: ReviewedPullRequest,
  diff: string,
  policy: ProjectPolicy,
  roles: ResolvedRoles,
  executeRole: RoleExecutor,
  signal: AbortSignal,
  verificationAdapter: VerificationAdapter,
  validationCommandsAllowed: boolean,
  artifacts: RoleExecutionArtifact[] = [],
  verification: VerificationContext = {
    evidenceCatalog: [],
    validationAttempts: [],
    limitations: [],
    coverageGaps: [],
  },
): Promise<OrchestrationExecutionResult> {
  const plan = orchestrationPlan(policy);
  const state: OrchestrationState = {
    candidates: [],
    advisories: [],
    roleInput: { task: "generate candidates" },
    assessments: [],
  };
  for (const step of plan.steps) {
    const configuredRole = roles[step.role];
    if (step.role === "verifier") {
      // oxlint-disable-next-line no-await-in-loop
      const gatheredVerification = await gatherVerificationContext(
        pullRequest,
        diff,
        state.candidates,
        policy,
        verificationAdapter,
        validationCommandsAllowed,
        signal,
        (attempt) => {
          const existing = verification.validationAttempts.findIndex(
            ({ commandIndex }) => commandIndex === attempt.commandIndex,
          );
          if (existing === -1) verification.validationAttempts.push(attempt);
          else verification.validationAttempts[existing] = attempt;
          verification.validationAttempts.sort(
            (left, right) => left.commandIndex - right.commandIndex,
          );
        },
      );
      Object.assign(verification, gatheredVerification);
      state.roleInput = { candidateFindings: state.candidates, ...verification };
    }
    // oxlint-disable-next-line no-await-in-loop
    const result = await executeRoleSafely(executeRole, {
      pullRequest,
      diff: scopedDiff(diff, policy),
      step,
      profile: configuredRole.profile,
      credentials: configuredRole.credentials,
      roleInput: state.roleInput,
      maxCandidateFindings: plan.maxCandidateFindings,
      signal,
    });
    if (result.type !== "completed") {
      if (result.artifact !== undefined) artifacts.push(result.artifact);
      return { ...result, verification, executionArtifacts: artifacts };
    }
    artifacts.push(result.artifact);
    if (result.output.role !== step.role) {
      return {
        type: "provider_failure",
        reason: `Provider returned ${result.output.role} output for the ${step.role} role.`,
        verification,
        executionArtifacts: artifacts,
      };
    }
    applyRoleOutput(state, result.output);
  }
  const verified = verifiedCandidates(
    state.candidates,
    state.advisories,
    state.assessments,
    verification,
  );
  const abstention = abstentionResult(verified, verification, artifacts);
  if (abstention !== undefined) return abstention;
  return {
    type: "completed",
    materialFindings: verified.findings,
    suppressedFindings: verified.suppressed,
    advisorySuggestions: verified.advisories,
    verification,
    executionArtifacts: artifacts,
  };
}
