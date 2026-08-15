import { findingCommandAuthorizationReason } from "./finding-command-authorization.js";
import type { PullRequestPersistenceKey, ReviewPersistenceStore } from "./persistence.js";
import { recognizePullRequestCommand, resolvePullRequestCommand } from "./pull-request-command.js";
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
import { routedCommandContext } from "./review-request-state.js";
import type {
  CommandWorkType,
  ReviewRequestEventRecord,
  RoutedCommand,
} from "./review-request-state.js";

export {
  claimReviewRequest,
  completeReviewRequest,
  reviewRequestIsActive,
} from "./review-request-lifecycle.js";

export interface ReviewRequestEvent {
  eventId: string;
  repository: string;
  defaultBranch: string;
  pullRequestNumber: number;
  actor: string;
  body: string;
  createdAt?: string | undefined;
}

export interface ReviewRequestPullRequest {
  number: number;
  author: string;
  baseSha: string;
  headSha: string;
  baseRepository: string;
  headRepository: string;
}

export type RepositoryPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

export interface ReviewDispatch {
  repository: string;
  pullRequestNumber: number;
  ref: string;
  baseSha: string;
  headSha: string;
  eventId: string;
  command?: RoutedCommand | undefined;
  workType?: CommandWorkType | undefined;
  findingFingerprint?: string | undefined;
  findingContext?: string | undefined;
  rootCommentId?: string | undefined;
}

export interface ReviewRequestIo {
  readPullRequest(repository: string, pullRequestNumber: number): Promise<ReviewRequestPullRequest>;
  readPermission(repository: string, actor: string): Promise<RepositoryPermission>;
  readPolicy(revision: string): Promise<string | undefined>;
  addEyes(eventId: string): Promise<void>;
  replyOnce(eventId: string, message: string): Promise<void>;
  dispatchReview(request: ReviewDispatch): Promise<void>;
}

export type ReviewRequestResult =
  | { type: "dispatched"; headSha: string; deprecatedAlias: boolean }
  | { type: "coalesced"; headSha: string; deprecatedAlias: boolean }
  | { type: "refused"; reason: string }
  | { type: "ignored" };

const writablePermissions = new Set<RepositoryPermission>(["write", "maintain", "admin"]);
const dependabotLogin = /^dependabot(?:\[bot\])?$/iu;

function keyFor(event: ReviewRequestEvent): PullRequestPersistenceKey {
  return { repository: event.repository, pullRequestNumber: event.pullRequestNumber };
}

function authorizationReason(
  event: ReviewRequestEvent,
  pullRequest: ReviewRequestPullRequest,
  permission: RepositoryPermission,
): string | undefined {
  const sameRepository =
    pullRequest.baseRepository === event.repository &&
    pullRequest.headRepository === event.repository;
  if (!sameRepository) {
    return "Diffowl only accepts Review requests for same-repository pull requests.";
  }
  if (dependabotLogin.test(pullRequest.author) || dependabotLogin.test(event.actor)) {
    return "Diffowl does not accept privileged Review requests from Dependabot.";
  }
  if (event.actor === pullRequest.author || writablePermissions.has(permission)) return undefined;
  return "Diffowl Review requests require the pull-request author or write, maintain, or admin access.";
}

interface RouteContext {
  pullRequest: ReviewRequestPullRequest;
  cooldownSeconds: number;
  requestTimeoutSeconds: number;
  reason?: string | undefined;
}

async function routeContext(
  event: ReviewRequestEvent,
  io: ReviewRequestIo,
  findingCommand: boolean,
): Promise<RouteContext> {
  const pullRequest = await io.readPullRequest(event.repository, event.pullRequestNumber);
  const permission =
    event.actor === pullRequest.author || findingCommand
      ? "read"
      : await io.readPermission(event.repository, event.actor);
  const denied = findingCommand
    ? findingCommandAuthorizationReason(event, pullRequest)
    : authorizationReason(event, pullRequest, permission);
  const policy = parseProjectPolicy(await io.readPolicy(pullRequest.baseSha));
  return {
    pullRequest,
    cooldownSeconds: policy.valid
      ? (policy.policy.reviewRequests?.cooldownSeconds ?? REVIEW_REQUEST_COOLDOWN_DEFAULT_SECONDS)
      : REVIEW_REQUEST_COOLDOWN_DEFAULT_SECONDS,
    requestTimeoutSeconds: policy.valid
      ? policy.policy.limits.reviewTimeoutSeconds
      : PROJECT_POLICY_CEILINGS.reviewTimeoutSeconds,
    reason: denied ?? (policy.valid ? undefined : policy.reason),
  };
}

async function acknowledge(
  event: ReviewRequestEvent,
  io: ReviewRequestIo,
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  record: ReviewRequestEventRecord,
  observedAt: string,
): Promise<void> {
  if (record.eyesAt !== undefined) return;
  await io.addEyes(event.eventId);
  await saveReviewRequestEffect(persistence, key, event.eventId, "eyesAt", observedAt);
}

async function refuse(
  event: ReviewRequestEvent,
  io: ReviewRequestIo,
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  record: ReviewRequestEventRecord,
  observedAt: string,
): Promise<ReviewRequestResult> {
  if (record.repliedAt === undefined) {
    await io.replyOnce(event.eventId, record.reason!);
    await saveReviewRequestEffect(persistence, key, event.eventId, "repliedAt", observedAt);
  }
  return { type: "refused", reason: record.reason! };
}

async function dispatch(
  event: ReviewRequestEvent,
  pullRequest: ReviewRequestPullRequest,
  io: ReviewRequestIo,
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  record: ReviewRequestEventRecord,
  observedAt: string,
): Promise<void> {
  if (record.dispatchedAt !== undefined) return;
  await io.dispatchReview({
    repository: event.repository,
    pullRequestNumber: pullRequest.number,
    ref: event.defaultBranch,
    baseSha: pullRequest.baseSha,
    headSha: record.headSha,
    eventId: record.eventId,
    ...routedCommandContext(record),
  });
  await saveReviewRequestEffect(persistence, key, record.eventId, "dispatchedAt", observedAt);
}

// oxlint-disable-next-line complexity
export async function routeReviewRequest(
  event: ReviewRequestEvent,
  io: ReviewRequestIo,
  persistence: ReviewPersistenceStore,
  now = new Date(),
): Promise<ReviewRequestResult> {
  const command = recognizePullRequestCommand(event.body);
  if (command === undefined) return { type: "ignored" };
  const findingCommand = command.type !== "review";
  const context = await routeContext(event, io, findingCommand);
  const observedAt =
    event.createdAt !== undefined && Number.isFinite(Date.parse(event.createdAt))
      ? new Date(event.createdAt).toISOString()
      : now.toISOString();
  const key = keyFor(event);
  await persistence.prepare?.(key);
  const routed = await resolvePullRequestCommand(
    command,
    persistence,
    key,
    event,
    context.pullRequest.headSha,
    observedAt,
  );
  const record = await persistReviewRequestDecision(persistence, key, {
    eventId: event.eventId,
    actor: event.actor,
    command: routed.command,
    deprecatedAlias: routed.deprecatedAlias,
    workType: routed.workType,
    observedAt,
    headSha: context.pullRequest.headSha,
    cooldownSeconds: context.cooldownSeconds,
    requestTimeoutSeconds: context.requestTimeoutSeconds,
    ...(routed.findingFingerprint === undefined
      ? {}
      : { findingFingerprint: routed.findingFingerprint }),
    ...(routed.findingContext === undefined ? {} : { findingContext: routed.findingContext }),
    ...(routed.rootCommentId === undefined ? {} : { rootCommentId: routed.rootCommentId }),
    ...(routed.reviewedHeadSha === undefined ? {} : { reviewedHeadSha: routed.reviewedHeadSha }),
    ...(routed.discussionEvent === undefined ? {} : { discussionEvent: routed.discussionEvent }),
    reason: context.reason ?? routed.reason,
  });
  if (record.decision === "refuse") {
    return refuse(event, io, persistence, key, record, observedAt);
  }
  await acknowledge(event, io, persistence, key, record, observedAt);
  const dispatchRecord = await resolveDispatchRecord(persistence, key, record);
  if (dispatchRecord?.decision === "dispatch") {
    await dispatch(event, context.pullRequest, io, persistence, key, dispatchRecord, observedAt);
  }
  return {
    type: record.decision === "dispatch" ? "dispatched" : "coalesced",
    headSha: record.headSha,
    deprecatedAlias: record.deprecatedAlias,
  };
}
