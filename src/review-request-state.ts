import type { FindingDiscussionCommand } from "./finding-discussion.js";

export type ReviewRequestDecision = "dispatch" | "coalesce" | "refuse";
export type ReviewRequestStatus = "queued" | "active" | "terminal" | "superseded";
export type CommandWorkType = "full_review" | "finding_discussion";
export type RoutedCommand = "review" | FindingDiscussionCommand;

export interface ReviewRequestEventRecord {
  eventId: string;
  actor: string;
  command: RoutedCommand;
  deprecatedAlias: boolean;
  observedAt: string;
  headSha: string;
  workType?: CommandWorkType | undefined;
  findingFingerprint?: string | undefined;
  findingContext?: string | undefined;
  rootCommentId?: string | undefined;
  reviewedHeadSha?: string | undefined;
  decision: ReviewRequestDecision;
  requestId?: string | undefined;
  reason?: string | undefined;
  eyesAt?: string | undefined;
  repliedAt?: string | undefined;
  dispatchedAt?: string | undefined;
}

export type RoutedCommandContext = Pick<
  ReviewRequestEventRecord,
  "command" | "findingFingerprint" | "findingContext" | "rootCommentId"
> & { workType: CommandWorkType };

export function routedCommandContext(record: ReviewRequestEventRecord): RoutedCommandContext {
  return {
    command: record.command,
    workType: record.workType ?? "full_review",
    ...(record.findingFingerprint === undefined
      ? {}
      : { findingFingerprint: record.findingFingerprint }),
    ...(record.findingContext === undefined ? {} : { findingContext: record.findingContext }),
    ...(record.rootCommentId === undefined ? {} : { rootCommentId: record.rootCommentId }),
  };
}

export interface ReviewRequestRecord {
  requestId: string;
  headSha: string;
  status: ReviewRequestStatus;
  requestedAt: string;
  activatedAt?: string | undefined;
  completedAt?: string | undefined;
  workflowRunId?: string | undefined;
}

export interface ReviewRequestLedger {
  version: 1;
  events: Record<string, ReviewRequestEventRecord>;
  requests: Record<string, ReviewRequestRecord>;
}

export function emptyReviewRequestLedger(): ReviewRequestLedger {
  return { version: 1, events: {}, requests: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function timestamp(value: unknown): value is string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) return false;
  return new Date(value).toISOString() === value;
}

function optionalTimestamp(value: unknown): value is string | undefined {
  return value === undefined || timestamp(value);
}

function hasOnlyFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).every((field) => fields.includes(field));
}

const eventFields = [
  "eventId",
  "actor",
  "command",
  "deprecatedAlias",
  "observedAt",
  "headSha",
  "workType",
  "findingFingerprint",
  "findingContext",
  "rootCommentId",
  "reviewedHeadSha",
  "decision",
  "requestId",
  "reason",
  "eyesAt",
  "repliedAt",
  "dispatchedAt",
];
const requestFields = [
  "requestId",
  "headSha",
  "status",
  "requestedAt",
  "activatedAt",
  "completedAt",
  "workflowRunId",
];

// oxlint-disable-next-line complexity
function validCommandState(value: Record<string, unknown>): boolean {
  if (value.command === "review") {
    return (
      (value.workType === undefined || value.workType === "full_review") &&
      value.findingFingerprint === undefined &&
      value.findingContext === undefined &&
      value.rootCommentId === undefined &&
      value.reviewedHeadSha === undefined
    );
  }
  const findingCommands = new Set<unknown>([
    "accept",
    "rebut",
    "suppress",
    "ignore",
    "resolved",
    "recheck",
    "explain",
    "reassess",
  ]);
  if (value.decision === "refuse") {
    return (
      findingCommands.has(value.command) &&
      (value.workType === "full_review" || value.workType === "finding_discussion")
    );
  }
  return (
    findingCommands.has(value.command) &&
    (value.workType === "full_review" || value.workType === "finding_discussion") &&
    typeof value.findingFingerprint === "string" &&
    value.findingFingerprint.length > 0 &&
    optionalString(value.findingContext) &&
    typeof value.rootCommentId === "string" &&
    value.rootCommentId.length > 0 &&
    typeof value.reviewedHeadSha === "string" &&
    value.reviewedHeadSha.length > 0
  );
}

function validEventState(value: Record<string, unknown>): boolean {
  if (value.decision === "refuse") {
    return (
      optionalString(value.reason) && value.reason !== undefined && value.requestId === undefined
    );
  }
  if (value.decision === "coalesce") {
    return (
      optionalString(value.requestId) && value.requestId !== undefined && value.reason === undefined
    );
  }
  return (
    value.decision === "dispatch" &&
    optionalString(value.requestId) &&
    value.requestId !== undefined &&
    value.reason === undefined
  );
}

function validRequestState(value: Record<string, unknown>): boolean {
  if (value.status === "active") {
    return value.activatedAt !== undefined && value.workflowRunId !== undefined;
  }
  if (value.status === "terminal") return value.completedAt !== undefined;
  return value.status === "queued" || value.status === "superseded";
}

// oxlint-disable-next-line complexity
function parseEvent(eventId: string, value: unknown): ReviewRequestEventRecord {
  if (!isRecord(value)) throw new Error(`Review request event "${eventId}" is invalid.`);
  const decision = value.decision;
  const valid =
    hasOnlyFields(value, eventFields) &&
    value.eventId === eventId &&
    typeof value.actor === "string" &&
    value.actor.length > 0 &&
    [
      "review",
      "accept",
      "rebut",
      "suppress",
      "ignore",
      "resolved",
      "recheck",
      "explain",
      "reassess",
    ].includes(String(value.command)) &&
    typeof value.deprecatedAlias === "boolean" &&
    timestamp(value.observedAt) &&
    typeof value.headSha === "string" &&
    value.headSha.length > 0 &&
    (decision === "dispatch" || decision === "coalesce" || decision === "refuse") &&
    optionalString(value.workType) &&
    optionalString(value.findingFingerprint) &&
    optionalString(value.findingContext) &&
    optionalString(value.rootCommentId) &&
    optionalString(value.reviewedHeadSha) &&
    optionalString(value.requestId) &&
    optionalString(value.reason) &&
    optionalTimestamp(value.eyesAt) &&
    optionalTimestamp(value.repliedAt) &&
    optionalTimestamp(value.dispatchedAt) &&
    validCommandState(value) &&
    validEventState(value);
  if (!valid) throw new Error(`Review request event "${eventId}" is invalid.`);
  return value as unknown as ReviewRequestEventRecord;
}

// oxlint-disable-next-line complexity
function parseRequest(requestId: string, value: unknown): ReviewRequestRecord {
  if (!isRecord(value)) throw new Error(`Review request "${requestId}" is invalid.`);
  const status = value.status;
  const valid =
    hasOnlyFields(value, requestFields) &&
    value.requestId === requestId &&
    typeof value.headSha === "string" &&
    value.headSha.length > 0 &&
    (status === "queued" ||
      status === "active" ||
      status === "terminal" ||
      status === "superseded") &&
    timestamp(value.requestedAt) &&
    optionalTimestamp(value.activatedAt) &&
    optionalTimestamp(value.completedAt) &&
    optionalString(value.workflowRunId) &&
    validRequestState(value);
  if (!valid) throw new Error(`Review request "${requestId}" is invalid.`);
  return value as unknown as ReviewRequestRecord;
}

function validateReferences(
  events: Record<string, ReviewRequestEventRecord>,
  requests: Record<string, ReviewRequestRecord>,
): void {
  for (const event of Object.values(events)) {
    if (event.requestId === undefined) continue;
    const request = requests[event.requestId];
    if (request === undefined || request.headSha !== event.headSha) {
      throw new Error(`Review request event "${event.eventId}" has an invalid request reference.`);
    }
  }
  for (const request of Object.values(requests)) {
    const event = events[request.requestId];
    if (event?.decision !== "dispatch" || event.requestId !== request.requestId) {
      throw new Error(`Review request "${request.requestId}" has no dispatch event.`);
    }
  }
}

export function parseReviewRequestLedger(value: unknown): ReviewRequestLedger {
  if (
    !isRecord(value) ||
    !hasOnlyFields(value, ["version", "events", "requests"]) ||
    value.version !== 1 ||
    !isRecord(value.events) ||
    !isRecord(value.requests)
  ) {
    throw new Error("Review request ledger is invalid.");
  }
  const events = Object.fromEntries(
    Object.entries(value.events).map(([eventId, event]) => [eventId, parseEvent(eventId, event)]),
  );
  const requests = Object.fromEntries(
    Object.entries(value.requests).map(([requestId, request]) => [
      requestId,
      parseRequest(requestId, request),
    ]),
  );
  validateReferences(events, requests);
  return { version: 1, events, requests };
}
