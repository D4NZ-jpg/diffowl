/* oxlint-disable max-lines */
import type { FindingDiscussionCommand } from "./finding-discussion.js";
import {
  FINDING_FINGERPRINT_ALGORITHM,
  FINDING_FINGERPRINT_VERSION,
} from "./finding-fingerprint.js";
import type { ReviewPersistenceStore } from "./persistence.js";
import type { ProjectPolicy, PolicySource } from "./project-policy.js";
import type {
  DiffowlCredentials,
  MaterialFinding,
  RoleExecutionArtifact,
  RoleExecutionRequest,
  RoleExecutionResult,
  ValidationAttempt,
  VerificationAdapter,
  VerificationContext,
} from "./review-orchestration.js";
import type { ReviewOutcome } from "./review-outcome.js";
import type { TrustClassification } from "./trust.js";

export interface FindingDiscussionWorkInput {
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
  eventId: string;
  workflowRunId: string;
  command: FindingDiscussionCommand;
  fingerprint: string;
  context?: string | undefined;
  policy: ProjectPolicy;
  policySource: PolicySource;
  trust: TrustClassification;
}

export interface FindingDiscussionWorkDependencies {
  persistence: ReviewPersistenceStore;
  verificationAdapter: VerificationAdapter;
  credentialProfiles: Readonly<Record<string, DiffowlCredentials>>;
  executeRole?: ((request: RoleExecutionRequest) => Promise<RoleExecutionResult>) | undefined;
}

export interface FindingDiscussionWorkResult {
  outcome: ReviewOutcome;
  finding: MaterialFinding;
  lifecycleState: MaterialFinding["lifecycleState"];
  replyBody: string;
}

async function validationAttempts(
  input: FindingDiscussionWorkInput,
  adapter: VerificationAdapter,
): Promise<ValidationAttempt[]> {
  const attempts: ValidationAttempt[] = [];
  if (input.command !== "recheck" && input.command !== "reassess") return attempts;
  for (const [commandIndex, command] of input.policy.verification.validationCommands.entries()) {
    const controller = new AbortController();
    // Project policy has already been parsed against the non-overridable timeout ceiling.
    // oxlint-disable-next-line no-await-in-loop
    const result = await adapter.executeValidation({
      argv: command.argv,
      timeoutSeconds: command.timeoutSeconds,
      maxOutputBytes: 64 * 1024,
      signal: controller.signal,
    });
    attempts.push({
      commandIndex,
      argv: command.argv,
      timeoutSeconds: command.timeoutSeconds,
      ...result,
    });
  }
  return attempts;
}

function verificationContext(
  input: FindingDiscussionWorkInput,
  attempts: ValidationAttempt[],
): VerificationContext {
  return {
    evidenceCatalog: attempts.map((attempt) => ({
      id: `validation:${attempt.commandIndex}`,
      type: "validation" as const,
      commandIndex: attempt.commandIndex,
      content: [attempt.stdout, attempt.stderr].filter(Boolean).join("\n") || attempt.status,
      truncated: attempt.truncated,
    })),
    validationAttempts: attempts,
    limitations:
      attempts.length === 0 && (input.command === "recheck" || input.command === "reassess")
        ? ["Project policy defines no deterministic validation commands."]
        : [],
    coverageGaps: [],
  };
}

function materialFinding(
  fingerprint: string,
  summary: string,
  path: string,
  line: number | undefined,
  lifecycleState: MaterialFinding["lifecycleState"],
  verification: VerificationContext,
  explanation: string,
): MaterialFinding {
  return {
    fingerprint: {
      version: FINDING_FINGERPRINT_VERSION,
      algorithm: FINDING_FINGERPRINT_ALGORITHM,
      value: fingerprint,
      components: {},
    },
    summary,
    location: { path, ...(line === undefined ? {} : { line }) },
    impact: "The original material impact remains under discussion.",
    evidence: verification.evidenceCatalog,
    lifecycleState,
    verificationState:
      verification.limitations.length === 0
        ? { type: "verified", explanation, limitations: [] }
        : {
            type: "verified_with_limitations",
            explanation,
            limitations: verification.limitations,
          },
  };
}

async function executeVerifier(
  input: FindingDiscussionWorkInput,
  executeRole: (request: RoleExecutionRequest) => Promise<RoleExecutionResult>,
  request: RoleExecutionRequest,
): Promise<RoleExecutionResult | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), input.policy.limits.reviewTimeoutSeconds * 1_000);
  });
  try {
    return await Promise.race([executeRole(request), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// oxlint-disable-next-line complexity, max-lines-per-function
async function reassessedState(
  input: FindingDiscussionWorkInput,
  dependencies: FindingDiscussionWorkDependencies,
  finding: MaterialFinding,
  verification: VerificationContext,
): Promise<{
  lifecycleState: MaterialFinding["lifecycleState"];
  explanation: string;
  artifacts: RoleExecutionArtifact[];
}> {
  const lifecycleDisposition: Partial<
    Record<FindingDiscussionCommand, MaterialFinding["lifecycleState"]>
  > = {
    accept: "accepted",
    rebut: "rebutted",
    suppress: "suppressed",
    ignore: "suppressed",
    resolved: "resolved",
  };
  const disposition = lifecycleDisposition[input.command];
  if (disposition !== undefined) {
    return {
      lifecycleState: disposition,
      explanation: `The author marked this Finding ${disposition}.`,
      artifacts: [],
    };
  }
  if (input.command !== "reassess") {
    return {
      lifecycleState: finding.lifecycleState,
      explanation:
        input.command === "recheck"
          ? "Deterministic Verification was rerun for this Finding."
          : "Review OWL restated the current Finding discussion state.",
      artifacts: [],
    };
  }
  const credentials =
    dependencies.credentialProfiles[input.policy.roleProfiles.verifier.credentialProfile];
  if (dependencies.executeRole === undefined || credentials === undefined) {
    return {
      lifecycleState: finding.lifecycleState,
      explanation: "Reassessment could not run because the configured verifier is unavailable.",
      artifacts: [],
    };
  }
  const controller = new AbortController();
  const roleRequest: RoleExecutionRequest = {
    pullRequest: {
      repository: input.repository,
      number: input.pullRequestNumber,
      baseSha: input.baseSha,
      headSha: input.headSha,
    },
    diff: "",
    step: { role: "verifier", purpose: "verify_candidates" },
    profile: input.policy.roleProfiles.verifier,
    credentials,
    roleInput: {
      candidateFindings: [
        {
          summary: finding.summary,
          location: finding.location,
          impact: finding.impact,
          evidence: finding.evidence.map((evidence) => evidence.content),
        },
      ],
      authorContext: input.context,
      ...verification,
    },
    maxCandidateFindings: 1,
    signal: controller.signal,
  };
  const result = await executeVerifier(input, dependencies.executeRole, roleRequest);
  if (result === undefined) {
    controller.abort();
    return {
      lifecycleState: finding.lifecycleState,
      explanation: "The bounded verifier timed out before producing a defensible reassessment.",
      artifacts: [],
    };
  }
  const artifacts = result.artifact === undefined ? [] : [result.artifact];
  if (result.type !== "completed" || result.output.role !== "verifier") {
    return {
      lifecycleState: finding.lifecycleState,
      explanation: "The bounded verifier did not produce a defensible reassessment.",
      artifacts,
    };
  }
  const assessment = result.output.assessments.find((candidate) => candidate.candidateIndex === 0);
  if (assessment === undefined) {
    return {
      lifecycleState: finding.lifecycleState,
      explanation: "The bounded verifier did not assess the Finding.",
      artifacts,
    };
  }
  const lifecycleState =
    assessment.disposition === "suppress"
      ? "suppressed"
      : assessment.disposition === "advisory"
        ? "rebutted"
        : finding.lifecycleState === "accepted"
          ? "accepted"
          : "persisting";
  return { lifecycleState, explanation: assessment.explanation, artifacts };
}

function replyBody(
  input: FindingDiscussionWorkInput,
  lifecycleState: MaterialFinding["lifecycleState"],
  explanation: string,
  attempts: ValidationAttempt[],
): string {
  const statuses =
    attempts.length === 0
      ? "No Project-policy validation command was available."
      : attempts
          .map((attempt) => `validation ${attempt.commandIndex}: ${attempt.status}`)
          .join("; ");
  const action =
    input.command === "recheck"
      ? "rechecked"
      : input.command === "reassess"
        ? "reassessed"
        : "updated";
  return [
    `Review OWL ${action} this Finding at \`${input.headSha}\`.`,
    "",
    explanation,
    "",
    ...(input.command === "recheck" || input.command === "reassess"
      ? [`Verification: ${statuses}`]
      : []),
    `Disposition: **${lifecycleState}**.`,
    `<!-- diffowl-finding-command:${input.eventId}:result -->`,
  ].join("\n");
}

// oxlint-disable-next-line complexity, max-lines-per-function
export async function runFindingDiscussionWork(
  input: FindingDiscussionWorkInput,
  dependencies: FindingDiscussionWorkDependencies,
): Promise<FindingDiscussionWorkResult> {
  const entry = await dependencies.persistence.withTransaction(
    { repository: input.repository, pullRequestNumber: input.pullRequestNumber },
    async (transaction) =>
      (await transaction.loadLedger())?.entries.find(
        (candidate) => candidate.fingerprint === input.fingerprint,
      ),
  );
  if (entry === undefined || entry.reviewedHeadSha !== input.headSha) {
    throw new Error("The bounded Finding command no longer matches the current reviewed revision.");
  }
  const attempts = await validationAttempts(input, dependencies.verificationAdapter);
  const verification = verificationContext(input, attempts);
  const original = materialFinding(
    entry.fingerprint,
    entry.summary,
    entry.locationPath ?? "unknown",
    entry.locationLine,
    entry.lifecycleState,
    verification,
    "Deterministic Verification was rerun for this Finding.",
  );
  const reassessed = await reassessedState(input, dependencies, original, verification);
  original.lifecycleState = reassessed.lifecycleState;
  original.verificationState =
    verification.limitations.length === 0
      ? { type: "verified", explanation: reassessed.explanation, limitations: [] }
      : {
          type: "verified_with_limitations",
          explanation: reassessed.explanation,
          limitations: verification.limitations,
        };
  await dependencies.persistence.withTransaction(
    { repository: input.repository, pullRequestNumber: input.pullRequestNumber },
    // oxlint-disable-next-line complexity
    async (transaction) => {
      const requests = await transaction.loadReviewRequests();
      const commandEvent = requests?.events[input.eventId];
      const commandRequest =
        commandEvent?.requestId === undefined
          ? undefined
          : requests?.requests[commandEvent.requestId];
      if (
        commandEvent?.findingFingerprint !== input.fingerprint ||
        commandRequest?.status !== "active" ||
        commandRequest.workflowRunId !== input.workflowRunId
      ) {
        throw new Error("The Finding command was superseded before applying its lifecycle result.");
      }
      const ledger = await transaction.loadLedger();
      const current = ledger?.entries.find(
        (candidate) => candidate.fingerprint === input.fingerprint,
      );
      if (ledger === undefined || current === undefined) {
        throw new Error("The Finding command target disappeared from durable state.");
      }
      if (current.reviewedHeadSha !== input.headSha) {
        throw new Error(
          "The bounded Finding command no longer matches the current reviewed revision.",
        );
      }
      if (current.lifecycleState !== reassessed.lifecycleState) {
        current.lifecycleState = reassessed.lifecycleState;
        current.lastChangedRunId = `command-${input.eventId}`;
      }
      await transaction.saveLedger(ledger);
    },
  );
  const outcome: ReviewOutcome = {
    type: "partial_coverage",
    reason: "Bounded Finding discussion work; no full Review was performed.",
    pullRequest: {
      repository: input.repository,
      number: input.pullRequestNumber,
      baseSha: input.baseSha,
      headSha: input.headSha,
    },
    policy: { source: input.policySource, effective: input.policy },
    trust: input.trust,
    materialFindings: [original],
    advisorySuggestions: [],
    verification,
    orchestrationPlan: {
      maxCandidateFindings: 1,
      steps:
        input.command === "reassess" ? [{ role: "verifier", purpose: "verify_candidates" }] : [],
    },
    executionArtifacts: reassessed.artifacts,
  };
  return {
    outcome,
    finding: original,
    lifecycleState: reassessed.lifecycleState,
    replyBody: replyBody(input, reassessed.lifecycleState, reassessed.explanation, attempts),
  };
}
