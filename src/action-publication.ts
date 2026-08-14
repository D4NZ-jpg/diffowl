import type { ActionIo } from "./action.js";
import type { GitHubPullRequestEvent } from "./action-event.js";
import type { JsonValue } from "./canonical-json.js";
import { jobSummaryBody } from "./github-presentation.js";
import {
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
    jobSummaryBody(outcome, receipt.result, "reviewUrl" in receipt ? receipt.reviewUrl : undefined),
  );
}

export async function recordNotAttemptedPublication(
  io: ActionIo,
  outcome: ReviewOutcome,
): Promise<void> {
  await recordPublicationOutput(io, outcome, publicationOutput("not_attempted"));
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
  try {
    const receipt = await io.publishOutcome(
      {
        repository,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.head.sha,
        changedLines,
      },
      outcome,
      { sourceRunVerified: true, surfaces: REQUIRED_PUBLICATION_SURFACES },
    );
    await recordPublicationOutput(io, outcome, receipt);
    if (outcome.run !== undefined) {
      await persistence?.withTransaction(
        { repository, pullRequestNumber: pullRequest.number },
        async (transaction) =>
          transaction.savePublicationEffects(outcome.run!.runId, receipt as unknown as JsonValue),
      );
    }
  } catch (error) {
    await recordPublicationOutput(
      io,
      outcome,
      publicationOutput(isPublicationRefusal(error) ? "refused" : "incomplete", error),
    );
    throw error;
  }
}
