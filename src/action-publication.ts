/* oxlint-disable max-lines */
import type { ActionIo } from "./action.js";
import type { GitHubPullRequestEvent } from "./action-event.js";
import type { JsonValue } from "./canonical-json.js";
import type {
  FindingDiscussionPublicationReceipt,
  FindingDiscussionPublicationUpdate,
} from "./github-finding-command.js";
import { jobSummaryBody } from "./github-presentation.js";
import {
  IncompletePublicationError,
  PublicationRefusalError,
  REQUIRED_PUBLICATION_SURFACES,
  isPublicationRefusal,
  type PublicationReceipt,
  type PublicationResult,
  type PublicationTarget,
} from "./github-publication.js";
import type {
  ReviewOutcome,
  ReviewPersistenceStore,
  ReviewPersistenceTransaction,
} from "./review-engine.js";
import { isTrustedPullRequest, type TrustClassification } from "./trust.js";

const trustedPullRequestClasses = new Set<TrustClassification["class"]>([
  "trusted_same_repo_pull_request",
  "trusted_collaborator_fork_pull_request",
]);

interface PublicationAuthority {
  version: 1;
  runId: string;
  recordedAt: string;
  headSha: string;
  result: PublicationResult;
}

interface PublicationState {
  version: 1;
  authority?: PublicationAuthority | undefined;
  effectOwners: Record<string, string>;
}

export async function setReviewOutputs(io: ActionIo, outcome: ReviewOutcome): Promise<void> {
  await io.setOutput("outcome", JSON.stringify(outcome));
  if (outcome.run !== undefined) {
    await io.setOutput("run-id", outcome.run.runId);
    await io.setOutput("run-metadata", JSON.stringify(outcome.run));
  }
}

function publicationOutput(
  result: PublicationResult,
  error?: unknown,
): { result: PublicationResult; reason?: string } {
  return {
    result,
    ...(error === undefined
      ? {}
      : { reason: error instanceof Error ? error.message : "GitHub publication failed." }),
  };
}

async function recordPublicationOutput(
  io: ActionIo,
  outcome: ReviewOutcome,
  receipt: PublicationReceipt | { result: PublicationResult; reason?: string },
): Promise<void> {
  await io.setOutput("publication", JSON.stringify(receipt));
  await io.writeJobSummary?.(
    jobSummaryBody(
      outcome,
      receipt.result,
      "reviewUrl" in receipt ? receipt.reviewUrl : undefined,
      io.workflowRunUrl,
    ),
  );
}

export async function recordNotAttemptedPublication(
  io: ActionIo,
  outcome: ReviewOutcome,
): Promise<void> {
  await recordPublicationOutput(io, outcome, publicationOutput("not_attempted"));
}

function validAuthority(value: unknown): value is PublicationAuthority {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as PublicationAuthority).version === 1 &&
    typeof (value as PublicationAuthority).runId === "string" &&
    typeof (value as PublicationAuthority).recordedAt === "string" &&
    Number.isFinite(Date.parse((value as PublicationAuthority).recordedAt)) &&
    typeof (value as PublicationAuthority).headSha === "string" &&
    ["complete", "not_attempted", "refused", "incomplete"].includes(
      String((value as PublicationAuthority).result),
    )
  );
}

// oxlint-disable-next-line complexity
function parsePublicationState(value: JsonValue | undefined): PublicationState {
  if (value === undefined) return { version: 1, effectOwners: {} };
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    value.version !== 1 ||
    (value.authority !== undefined && !validAuthority(value.authority)) ||
    typeof value.effectOwners !== "object" ||
    value.effectOwners === null ||
    Array.isArray(value.effectOwners) ||
    !Object.entries(value.effectOwners).every(
      ([effectId, runId]) =>
        /^sha256:[\da-f]{64}$/u.test(effectId) && typeof runId === "string" && runId.length > 0,
    )
  ) {
    throw new Error("Persisted publication state is invalid.");
  }
  return value as unknown as PublicationState;
}

function newerRun(
  candidate: { runId: string; recordedAt: string },
  current: { runId: string; recordedAt: string },
): boolean {
  const timeDifference = Date.parse(candidate.recordedAt) - Date.parse(current.recordedAt);
  return timeDifference > 0 || (timeDifference === 0 && candidate.runId > current.runId);
}

async function candidateAuthority(
  transaction: ReviewPersistenceTransaction,
  repository: string,
  pullRequestNumber: number,
  outcome: ReviewOutcome,
  headSha: string,
): Promise<PublicationAuthority> {
  if (outcome.run === undefined)
    throw new PublicationRefusalError("Verified run metadata is missing.");
  const record = await transaction.loadRunRecord(outcome.run.runId);
  if (record === undefined)
    throw new PublicationRefusalError("The verified run record is unavailable.");
  const revision = record.revision?.pullRequest;
  if (
    record.runId !== outcome.run.runId ||
    revision?.repository !== repository ||
    revision.number !== pullRequestNumber ||
    revision.headSha !== headSha ||
    !trustedPullRequestClasses.has(record.trustClass)
  ) {
    throw new PublicationRefusalError("The verified run record does not match publication.");
  }
  return {
    version: 1,
    runId: record.runId,
    recordedAt: record.recordedAt,
    headSha,
    result: "incomplete",
  };
}

async function claimPublication(
  persistence: ReviewPersistenceStore | undefined,
  repository: string,
  pullRequestNumber: number,
  outcome: ReviewOutcome,
  headSha: string,
): Promise<void> {
  if (persistence === undefined)
    throw new PublicationRefusalError("Trustworthy publication state is unavailable.");
  await persistence.withTransaction({ repository, pullRequestNumber }, async (transaction) => {
    const candidate = await candidateAuthority(
      transaction,
      repository,
      pullRequestNumber,
      outcome,
      headSha,
    );
    const state = parsePublicationState(await transaction.loadPublicationState());
    const current = state.authority;
    if (
      current !== undefined &&
      current.headSha === candidate.headSha &&
      current.runId !== candidate.runId &&
      !newerRun(candidate, current)
    ) {
      throw new PublicationRefusalError("A newer verified run already owns GitHub publication.");
    }
    await transaction.savePublicationEffects(candidate.runId, {
      result: "incomplete",
      headSha,
      inlineCommentCount: 0,
      unanchoredFindingCount: 0,
      reason: "Publication attempt started but has not completed.",
    } as JsonValue);
    await transaction.savePublicationState({
      ...state,
      authority: candidate,
    } as unknown as JsonValue);
  });
}

async function reservePublicationEffect(
  persistence: ReviewPersistenceStore,
  repository: string,
  pullRequestNumber: number,
  outcome: ReviewOutcome,
  headSha: string,
  effectId: string,
): Promise<"create" | "reconcile"> {
  return persistence.withTransaction(
    { repository, pullRequestNumber },
    async (transaction): Promise<"create" | "reconcile"> => {
      const candidate = await candidateAuthority(
        transaction,
        repository,
        pullRequestNumber,
        outcome,
        headSha,
      );
      const state = parsePublicationState(await transaction.loadPublicationState());
      if (state.authority?.runId !== candidate.runId) {
        throw new PublicationRefusalError("A newer verified run superseded GitHub publication.");
      }
      if (state.effectOwners[effectId] !== undefined) return "reconcile";
      await transaction.savePublicationState({
        ...state,
        effectOwners: { ...state.effectOwners, [effectId]: candidate.runId },
      } as unknown as JsonValue);
      return "create";
    },
  );
}

async function savePublicationEffects(
  persistence: ReviewPersistenceStore | undefined,
  repository: string,
  pullRequestNumber: number,
  outcome: ReviewOutcome,
  receipt: PublicationReceipt | { result: PublicationResult; reason?: string },
): Promise<void> {
  if (persistence === undefined || outcome.run === undefined) return;
  await persistence.withTransaction({ repository, pullRequestNumber }, async (transaction) => {
    await transaction.savePublicationEffects(outcome.run!.runId, receipt as unknown as JsonValue);
    const state = parsePublicationState(await transaction.loadPublicationState());
    if (state.authority?.runId === outcome.run!.runId) {
      await transaction.savePublicationState({
        ...state,
        authority: { ...state.authority, result: receipt.result },
      } as unknown as JsonValue);
    }
  });
}

function incompleteEffects(
  confirmedEffects: PublicationReceipt,
  error: unknown,
): PublicationReceipt {
  return {
    ...confirmedEffects,
    result: "incomplete",
    reason: error instanceof Error ? error.message : "GitHub publication failed.",
  };
}

async function recordFailureOutput(
  io: ActionIo,
  outcome: ReviewOutcome,
  publication: PublicationReceipt | { result: PublicationResult; reason?: string },
): Promise<void> {
  try {
    await recordPublicationOutput(io, outcome, publication);
  } catch {
    // The original required-surface failure remains the Action failure.
  }
}

async function preserveFailureEffects(
  persistence: ReviewPersistenceStore | undefined,
  repository: string,
  pullRequestNumber: number,
  outcome: ReviewOutcome,
  effects: PublicationReceipt | { result: PublicationResult; reason?: string },
): Promise<void> {
  try {
    await savePublicationEffects(persistence, repository, pullRequestNumber, outcome, effects);
  } catch {
    // Failure reporting must still reach the available Action surfaces.
  }
}

async function saveFindingDiscussionEffects(
  persistence: ReviewPersistenceStore,
  repository: string,
  pullRequestNumber: number,
  eventId: string,
  receipt: FindingDiscussionPublicationReceipt | { result: PublicationResult; reason?: string },
): Promise<void> {
  await persistence.withTransaction({ repository, pullRequestNumber }, async (transaction) => {
    await transaction.savePublicationEffects(`command-${eventId}`, receipt as unknown as JsonValue);
  });
}

export async function publishFindingDiscussionActionOutcome(
  io: ActionIo,
  repository: string,
  pullRequestNumber: number,
  eventId: string,
  outcome: ReviewOutcome,
  update: FindingDiscussionPublicationUpdate,
  persistence: ReviewPersistenceStore,
): Promise<void> {
  await setReviewOutputs(io, outcome);
  if (io.publishFindingDiscussion === undefined || !isTrustedPullRequest(outcome.trust)) {
    await recordNotAttemptedPublication(io, outcome);
    return;
  }
  let publication:
    | FindingDiscussionPublicationReceipt
    | { result: PublicationResult; reason?: string };
  try {
    publication = await io.publishFindingDiscussion(update);
  } catch (error) {
    publication =
      error instanceof IncompletePublicationError
        ? (error.confirmedEffects as FindingDiscussionPublicationReceipt)
        : publicationOutput(isPublicationRefusal(error) ? "refused" : "incomplete", error);
  }
  await preserveFailureEffects(persistence, repository, pullRequestNumber, outcome, publication);
  await saveFindingDiscussionEffects(
    persistence,
    repository,
    pullRequestNumber,
    eventId,
    publication,
  );
  await recordPublicationOutput(io, outcome, publication);
  if (publication.result !== "complete") {
    throw new Error(
      publication.reason ?? `Finding discussion publication was ${publication.result}.`,
    );
  }
}

// oxlint-disable-next-line max-lines-per-function
export async function publishActionOutcome(
  io: ActionIo,
  repository: string,
  pullRequest: GitHubPullRequestEvent["pull_request"],
  outcome: ReviewOutcome,
  changedLines: PublicationTarget["changedLines"],
  persistence: ReviewPersistenceStore | undefined,
): Promise<void> {
  await setReviewOutputs(io, outcome);
  if (io.publishOutcome === undefined || !isTrustedPullRequest(outcome.trust)) {
    await recordNotAttemptedPublication(io, outcome);
    return;
  }
  let confirmedEffects: PublicationReceipt | undefined;
  try {
    confirmedEffects = await io.publishOutcome(
      {
        repository,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.head.sha,
        changedLines,
      },
      outcome,
      {
        sourceRunVerified: true,
        surfaces: REQUIRED_PUBLICATION_SURFACES,
        claimAuthority: async () =>
          claimPublication(
            persistence,
            repository,
            pullRequest.number,
            outcome,
            pullRequest.head.sha,
          ),
        reserveEffect: async (effectId) => {
          if (persistence === undefined)
            throw new PublicationRefusalError("Trustworthy publication state is unavailable.");
          return reservePublicationEffect(
            persistence,
            repository,
            pullRequest.number,
            outcome,
            pullRequest.head.sha,
            effectId,
          );
        },
      },
    );
    await savePublicationEffects(
      persistence,
      repository,
      pullRequest.number,
      outcome,
      confirmedEffects,
    );
    await recordPublicationOutput(io, outcome, confirmedEffects);
  } catch (error) {
    const effects =
      error instanceof IncompletePublicationError
        ? error.confirmedEffects
        : confirmedEffects === undefined
          ? undefined
          : incompleteEffects(confirmedEffects, error);
    const publication =
      effects ?? publicationOutput(isPublicationRefusal(error) ? "refused" : "incomplete", error);
    await preserveFailureEffects(persistence, repository, pullRequest.number, outcome, publication);
    await recordFailureOutput(io, outcome, publication);
    throw error;
  }
}
