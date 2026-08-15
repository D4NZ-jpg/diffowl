import type { PullRequestPersistenceKey, ReviewPersistenceStore } from "./persistence.js";
import {
  emptyReviewRequestLedger,
  type ReviewRequestEventRecord,
  type ReviewRequestLedger,
  type ReviewRequestRecord,
} from "./review-request-state.js";

export interface ReviewRequestDecisionInput {
  eventId: string;
  actor: string;
  deprecatedAlias: boolean;
  observedAt: string;
  headSha: string;
  cooldownSeconds: number;
  requestTimeoutSeconds: number;
  reason?: string | undefined;
}

function baseEventRecord(input: ReviewRequestDecisionInput) {
  return {
    eventId: input.eventId,
    actor: input.actor,
    command: "review" as const,
    deprecatedAlias: input.deprecatedAlias,
    observedAt: input.observedAt,
    headSha: input.headSha,
  };
}

function coalescibleRequest(
  ledger: ReviewRequestLedger,
  input: ReviewRequestDecisionInput,
): ReviewRequestRecord | undefined {
  const observedAt = Date.parse(input.observedAt);
  for (const [requestId, request] of Object.entries(ledger.requests)) {
    const open = request.status === "queued" || request.status === "active";
    if (request.headSha !== input.headSha || !open) continue;
    const startedAt = Date.parse(
      request.status === "active" ? request.activatedAt! : request.requestedAt,
    );
    if (observedAt < startedAt + input.requestTimeoutSeconds * 1_000) return request;
    ledger.requests[requestId] = { ...request, status: "superseded" };
  }
  return undefined;
}

function compareEventIds(left: string, right: string): number {
  if (/^\d+$/u.test(left) && /^\d+$/u.test(right)) {
    const leftId = BigInt(left);
    const rightId = BigInt(right);
    return leftId === rightId ? 0 : leftId > rightId ? 1 : -1;
  }
  return left.localeCompare(right);
}

function newerRevisionExists(
  ledger: ReviewRequestLedger,
  input: ReviewRequestDecisionInput,
): boolean {
  const observedAt = Date.parse(input.observedAt);
  return Object.values(ledger.requests).some((request) => {
    if (request.headSha === input.headSha) return false;
    const existingObservedAt = Date.parse(request.requestedAt);
    if (existingObservedAt !== observedAt) return existingObservedAt > observedAt;
    return compareEventIds(request.requestId, input.eventId) > 0;
  });
}

function lastCompletion(ledger: ReviewRequestLedger, headSha: string): number {
  const completed = Object.values(ledger.requests)
    .filter(
      (request) =>
        request.headSha === headSha &&
        request.status === "terminal" &&
        request.completedAt !== undefined,
    )
    .map((request) => Date.parse(request.completedAt!))
    .filter(Number.isFinite);
  return completed.length === 0 ? 0 : Math.max(...completed);
}

function supersedeOpenRequests(ledger: ReviewRequestLedger, headSha: string): void {
  for (const [requestId, request] of Object.entries(ledger.requests)) {
    const open = request.status === "queued" || request.status === "active";
    if (request.headSha !== headSha && open) {
      ledger.requests[requestId] = { ...request, status: "superseded" };
    }
  }
}

function decideReviewRequest(
  ledger: ReviewRequestLedger,
  input: ReviewRequestDecisionInput,
): { event: ReviewRequestEventRecord; request?: ReviewRequestRecord } {
  if (input.reason !== undefined) {
    return {
      event: { ...baseEventRecord(input), decision: "refuse", reason: input.reason },
    };
  }
  if (newerRevisionExists(ledger, input)) {
    return {
      event: {
        ...baseEventRecord(input),
        decision: "refuse",
        reason: "A newer pull-request revision superseded this Review request.",
      },
    };
  }
  const active = coalescibleRequest(ledger, input);
  if (active !== undefined) {
    return {
      event: {
        ...baseEventRecord(input),
        decision: "coalesce",
        requestId: active.requestId,
      },
    };
  }
  const completedAt = lastCompletion(ledger, input.headSha);
  if (
    completedAt > 0 &&
    Date.parse(input.observedAt) < completedAt + input.cooldownSeconds * 1_000
  ) {
    return {
      event: {
        ...baseEventRecord(input),
        decision: "refuse",
        reason: `Diffowl reviewed this head recently; try again after the ${input.cooldownSeconds}-second cooldown.`,
      },
    };
  }
  supersedeOpenRequests(ledger, input.headSha);
  const request: ReviewRequestRecord = {
    requestId: input.eventId,
    headSha: input.headSha,
    status: "queued",
    requestedAt: input.observedAt,
  };
  return {
    event: {
      ...baseEventRecord(input),
      decision: "dispatch",
      requestId: request.requestId,
    },
    request,
  };
}

export async function persistReviewRequestDecision(
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  input: ReviewRequestDecisionInput,
): Promise<ReviewRequestEventRecord> {
  return persistence.withTransaction(key, async (transaction) => {
    const ledger = (await transaction.loadReviewRequests()) ?? emptyReviewRequestLedger();
    const previous = ledger.events[input.eventId];
    if (previous !== undefined) return previous;
    const decision = decideReviewRequest(ledger, input);
    ledger.events[input.eventId] = decision.event;
    if (decision.request !== undefined) {
      ledger.requests[decision.request.requestId] = decision.request;
    }
    await transaction.saveReviewRequests(ledger);
    return decision.event;
  });
}

export async function loadReviewRequestEvent(
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  eventId: string,
): Promise<ReviewRequestEventRecord | undefined> {
  return persistence.withTransaction(key, async (transaction) => {
    const ledger = (await transaction.loadReviewRequests()) ?? emptyReviewRequestLedger();
    return ledger.events[eventId];
  });
}

export async function saveReviewRequestEffect(
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  eventId: string,
  field: "eyesAt" | "repliedAt" | "dispatchedAt",
  at: string,
): Promise<void> {
  await persistence.withTransaction(key, async (transaction) => {
    const ledger = (await transaction.loadReviewRequests()) ?? emptyReviewRequestLedger();
    const event = ledger.events[eventId];
    if (event === undefined) throw new Error(`Review request event "${eventId}" is missing.`);
    ledger.events[eventId] = { ...event, [field]: at };
    await transaction.saveReviewRequests(ledger);
  });
}

function claimDisposition(
  event: ReviewRequestEventRecord | undefined,
  request: ReviewRequestRecord | undefined,
  headSha: string,
  workflowRunId: string,
): "claim" | "resume" | "refuse" {
  const matches =
    event?.decision === "dispatch" && event.headSha === headSha && request?.headSha === headSha;
  if (!matches || request === undefined) return "refuse";
  if (request.status === "active" && request.workflowRunId === workflowRunId) return "resume";
  return request.status === "queued" ? "claim" : "refuse";
}

export async function claimReviewRequest(
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  eventId: string,
  headSha: string,
  workflowRunId: string,
  now = new Date(),
): Promise<boolean> {
  await persistence.prepare?.(key);
  return persistence.withTransaction(key, async (transaction) => {
    const ledger = (await transaction.loadReviewRequests()) ?? emptyReviewRequestLedger();
    const event = ledger.events[eventId];
    const request = event?.requestId === undefined ? undefined : ledger.requests[event.requestId];
    const disposition = claimDisposition(event, request, headSha, workflowRunId);
    if (disposition === "refuse" || request === undefined) return false;
    if (disposition === "resume") return true;
    ledger.requests[request.requestId] = {
      ...request,
      status: "active",
      activatedAt: now.toISOString(),
      workflowRunId,
    };
    await transaction.saveReviewRequests(ledger);
    return true;
  });
}

export async function reviewRequestIsActive(
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  eventId: string,
  workflowRunId: string,
): Promise<boolean> {
  return persistence.withTransaction(key, async (transaction) => {
    const ledger = (await transaction.loadReviewRequests()) ?? emptyReviewRequestLedger();
    const event = ledger.events[eventId];
    const request = event?.requestId === undefined ? undefined : ledger.requests[event.requestId];
    return request?.status === "active" && request.workflowRunId === workflowRunId;
  });
}

export async function completeReviewRequest(
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  eventId: string,
  workflowRunId: string,
  now = new Date(),
): Promise<void> {
  await persistence.withTransaction(key, async (transaction) => {
    const ledger = (await transaction.loadReviewRequests()) ?? emptyReviewRequestLedger();
    const event = ledger.events[eventId];
    const request = event?.requestId === undefined ? undefined : ledger.requests[event.requestId];
    if (request?.status !== "active" || request.workflowRunId !== workflowRunId) return;
    ledger.requests[request.requestId] = {
      ...request,
      status: "terminal",
      completedAt: now.toISOString(),
    };
    await transaction.saveReviewRequests(ledger);
  });
}
