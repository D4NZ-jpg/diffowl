import { findingCommandAuthorizationReason } from "./finding-command-authorization.js";
import {
  findingIdentityMarker,
  parseFindingDiscussionCommandBody,
  type FindingDiscussionEvent,
} from "./finding-discussion.js";
import type { PullRequestPersistenceKey, ReviewPersistenceStore } from "./persistence.js";
import {
  parseProjectPolicy,
  PROJECT_POLICY_CEILINGS,
  REVIEW_REQUEST_COOLDOWN_DEFAULT_SECONDS,
} from "./project-policy.js";
import {
  persistReviewRequestDecision,
  resolveDispatchRecord,
  saveReviewRequestEffect,
} from "./review-request-lifecycle.js";
import { routedCommandContext, type ReviewRequestEventRecord } from "./review-request-state.js";
import type { ReviewDispatch, ReviewRequestPullRequest } from "./review-request.js";

export interface FindingCommandReviewComment {
  id: string;
  actor: string;
  body: string;
  createdAt: string;
  isBot?: boolean | undefined;
  inReplyToId?: string | undefined;
}

export interface FindingCommandEvent extends FindingCommandReviewComment {
  repository: string;
  defaultBranch: string;
  pullRequestNumber: number;
}

export interface FindingCommandIo {
  readPullRequest(repository: string, pullRequestNumber: number): Promise<ReviewRequestPullRequest>;
  readPolicy(revision: string): Promise<string | undefined>;
  readReviewComment(repository: string, commentId: string): Promise<FindingCommandReviewComment>;
  addEyes(eventId: string): Promise<void>;
  replyOnce(eventId: string, rootCommentId: string | undefined, message: string): Promise<void>;
  dispatchReview(request: ReviewDispatch): Promise<void>;
}

export type FindingCommandResult =
  | {
      type: "dispatched";
      headSha: string;
      workType: "full_review" | "finding_discussion";
      fingerprint: string;
    }
  | { type: "refused"; reason: string }
  | { type: "ignored" };

function keyFor(event: FindingCommandEvent): PullRequestPersistenceKey {
  return { repository: event.repository, pullRequestNumber: event.pullRequestNumber };
}

async function rootComment(
  event: FindingCommandEvent,
  io: FindingCommandIo,
): Promise<FindingCommandReviewComment | undefined> {
  let commentId = event.inReplyToId;
  if (commentId === undefined) return undefined;
  const visited = new Set<string>([event.id]);
  for (let depth = 0; depth < 100; depth += 1) {
    if (visited.has(commentId)) return undefined;
    visited.add(commentId);
    // Nested reply ancestry is bounded and each comment is read at most once.
    // oxlint-disable-next-line no-await-in-loop
    const comment = await io.readReviewComment(event.repository, commentId);
    if (comment.id !== commentId) return undefined;
    if (comment.inReplyToId === undefined) return comment;
    commentId = comment.inReplyToId;
  }
  return undefined;
}

function commandEvent(
  event: FindingCommandEvent,
  root: FindingCommandReviewComment,
  pullRequestAuthor: string,
): FindingDiscussionEvent | undefined {
  if (
    event.actor !== pullRequestAuthor ||
    root.isBot !== true ||
    root.actor !== "github-actions[bot]"
  ) {
    return undefined;
  }
  const parsed = parseFindingDiscussionCommandBody(event.body);
  const fingerprint = /^<!-- diffowl:finding:v1 fingerprint=(sha256:[\da-f]{64}) -->/iu.exec(
    root.body,
  )?.[1];
  if (parsed === undefined || fingerprint === undefined) return undefined;
  const rootPrefix = `${findingIdentityMarker(fingerprint)}\n### Review OWL material Finding`;
  if (root.body !== rootPrefix && !root.body.startsWith(`${rootPrefix}\n`)) return undefined;
  return {
    id: event.id,
    fingerprint: fingerprint.toLowerCase(),
    actor: event.actor,
    command: parsed.command,
    createdAt: event.createdAt,
    ...(parsed.body === undefined ? {} : { body: parsed.body }),
    source: "pull_request_review_comment",
  };
}

async function findingState(
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  fingerprint: string,
) {
  return persistence.withTransaction(key, async (transaction) => {
    const ledger = await transaction.loadLedger();
    return ledger?.entries.find((entry) => entry.fingerprint === fingerprint);
  });
}

async function acknowledge(
  event: FindingCommandEvent,
  io: FindingCommandIo,
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  record: ReviewRequestEventRecord,
  observedAt: string,
): Promise<void> {
  if (record.eyesAt !== undefined) return;
  await io.addEyes(event.id);
  await saveReviewRequestEffect(persistence, key, event.id, "eyesAt", observedAt);
}

async function refuse(
  event: FindingCommandEvent,
  rootCommentId: string | undefined,
  io: FindingCommandIo,
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  record: ReviewRequestEventRecord,
  observedAt: string,
): Promise<FindingCommandResult> {
  const reason = record.reason!;
  if (record.repliedAt === undefined) {
    await io.replyOnce(event.id, rootCommentId, reason);
    await saveReviewRequestEffect(persistence, key, event.id, "repliedAt", observedAt);
  }
  return { type: "refused", reason };
}

// oxlint-disable-next-line complexity, max-lines-per-function
export async function routeFindingCommand(
  event: FindingCommandEvent,
  io: FindingCommandIo,
  persistence: ReviewPersistenceStore,
  now = new Date(),
): Promise<FindingCommandResult> {
  const parsed = parseFindingDiscussionCommandBody(event.body);
  if (parsed === undefined) return { type: "ignored" };
  const pullRequest = await io.readPullRequest(event.repository, event.pullRequestNumber);
  const root = await rootComment(event, io);
  const recognized = root === undefined ? undefined : commandEvent(event, root, pullRequest.author);
  const fingerprint = recognized?.fingerprint;
  const key = keyFor(event);
  await persistence.prepare?.(key);
  const entry =
    fingerprint === undefined ? undefined : await findingState(persistence, key, fingerprint);
  const policy = parseProjectPolicy(await io.readPolicy(pullRequest.baseSha));
  const denied = findingCommandAuthorizationReason(event, pullRequest);
  const reason =
    denied ??
    (root === undefined || recognized === undefined
      ? "The review comment is not a reply inside an engine-owned Diffowl Finding discussion."
      : entry === undefined || entry.reviewedHeadSha === undefined
        ? "The Finding command target is not present in durable state."
        : policy.valid
          ? undefined
          : policy.reason);
  const reviewedHeadSha = entry?.reviewedHeadSha;
  const workType =
    reviewedHeadSha !== undefined && reviewedHeadSha === pullRequest.headSha
      ? "finding_discussion"
      : "full_review";
  const observedAt = Number.isFinite(Date.parse(event.createdAt))
    ? new Date(event.createdAt).toISOString()
    : now.toISOString();
  const record = await persistReviewRequestDecision(persistence, key, {
    eventId: event.id,
    actor: event.actor,
    command: parsed.command,
    observedAt,
    headSha: pullRequest.headSha,
    cooldownSeconds: policy.valid
      ? (policy.policy.reviewRequests?.cooldownSeconds ?? REVIEW_REQUEST_COOLDOWN_DEFAULT_SECONDS)
      : REVIEW_REQUEST_COOLDOWN_DEFAULT_SECONDS,
    requestTimeoutSeconds: policy.valid
      ? policy.policy.limits.reviewTimeoutSeconds
      : PROJECT_POLICY_CEILINGS.reviewTimeoutSeconds,
    workType,
    ...(fingerprint === undefined ? {} : { findingFingerprint: fingerprint }),
    ...(parsed.body === undefined ? {} : { findingContext: parsed.body }),
    ...(root === undefined ? {} : { rootCommentId: root.id }),
    ...(reviewedHeadSha === undefined ? {} : { reviewedHeadSha }),
    ...(recognized === undefined ? {} : { discussionEvent: recognized }),
    reason,
  });
  if (record.decision === "refuse") {
    return refuse(event, root?.id, io, persistence, key, record, observedAt);
  }
  await acknowledge(event, io, persistence, key, record, observedAt);
  const dispatchRecord = await resolveDispatchRecord(persistence, key, record);
  if (dispatchRecord?.decision === "dispatch" && dispatchRecord.dispatchedAt === undefined) {
    await io.dispatchReview({
      repository: event.repository,
      pullRequestNumber: pullRequest.number,
      ref: event.defaultBranch,
      baseSha: pullRequest.baseSha,
      headSha: dispatchRecord.headSha,
      eventId: dispatchRecord.eventId,
      ...routedCommandContext(dispatchRecord),
    });
    await saveReviewRequestEffect(
      persistence,
      key,
      dispatchRecord.eventId,
      "dispatchedAt",
      observedAt,
    );
  }
  return {
    type: "dispatched",
    headSha: record.headSha,
    workType: record.workType!,
    fingerprint: record.findingFingerprint!,
  };
}

export { findingIdentityMarker };
