import type { ActionIo } from "./action.js";
import type { GitHubPullRequestEvent } from "./action-event.js";
import type { JsonValue } from "./canonical-json.js";
import { jobSummaryBody } from "./github-presentation.js";
import {
  IncompletePublicationError,
  REQUIRED_PUBLICATION_SURFACES,
  isPublicationRefusal,
  type PublicationReceipt,
  type PublicationResult,
  type PublicationTarget,
} from "./github-publication.js";
import type { ReviewOutcome, ReviewPersistenceStore } from "./review-engine.js";

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

async function savePublicationEffects(
  persistence: ReviewPersistenceStore | undefined,
  repository: string,
  pullRequestNumber: number,
  outcome: ReviewOutcome,
  receipt: PublicationReceipt,
): Promise<void> {
  if (persistence === undefined || outcome.run === undefined) return;
  await persistence.withTransaction({ repository, pullRequestNumber }, async (transaction) =>
    transaction.savePublicationEffects(outcome.run!.runId, receipt as unknown as JsonValue),
  );
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
  effects: PublicationReceipt,
): Promise<void> {
  try {
    await savePublicationEffects(persistence, repository, pullRequestNumber, outcome, effects);
  } catch {
    // Failure reporting must still reach the available Action surfaces.
  }
}

export async function publishActionOutcome(
  io: ActionIo,
  repository: string,
  pullRequest: GitHubPullRequestEvent["pull_request"],
  outcome: ReviewOutcome,
  changedLines: PublicationTarget["changedLines"],
  persistence: ReviewPersistenceStore | undefined,
): Promise<void> {
  await setReviewOutputs(io, outcome);
  if (io.publishOutcome === undefined || outcome.trust.class !== "trusted_same_repo_pull_request") {
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
      { sourceRunVerified: true, surfaces: REQUIRED_PUBLICATION_SURFACES },
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
    if (effects !== undefined)
      await preserveFailureEffects(persistence, repository, pullRequest.number, outcome, effects);
    await recordFailureOutput(io, outcome, publication);
    throw error;
  }
}
