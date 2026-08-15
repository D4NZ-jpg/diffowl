import type { FindingDiscussionCommand, FindingDiscussionEvent } from "./finding-discussion.js";
import { findingShortIdentityFromFingerprint } from "./finding-fingerprint.js";
import type { FindingLedgerEntry } from "./finding-ledger.js";
import type { PullRequestPersistenceKey, ReviewPersistenceStore } from "./persistence.js";
import type { CommandWorkType, RoutedCommand } from "./review-request-state.js";

export type PullRequestCommand =
  | { type: "review" }
  | {
      type: "finding";
      command: Extract<FindingDiscussionCommand, "recheck" | "reassess">;
      findingId: string;
      context?: string | undefined;
    }
  | { type: "malformed_finding"; reason: string };

export function recognizePullRequestCommand(body: string): PullRequestCommand | undefined {
  const text = body.trim();
  if (text === "/diffowl review") return { type: "review" };
  const recheck = text.match(/^\/diffowl recheck (F-[\da-f]{8})$/iu);
  if (recheck !== null) {
    return { type: "finding", command: "recheck", findingId: recheck[1]!.toUpperCase() };
  }
  const reassess = text.match(/^\/diffowl reassess (F-[\da-f]{8})[ \t]+([^\r\n]+)$/iu);
  if (reassess !== null) {
    return {
      type: "finding",
      command: "reassess",
      findingId: reassess[1]!.toUpperCase(),
      context: reassess[2]!.trim(),
    };
  }
  if (!/^\/diffowl (?:recheck|reassess)\b/iu.test(text)) return undefined;
  return {
    type: "malformed_finding",
    reason: "Use `/diffowl recheck F-1234abcd` or `/diffowl reassess F-1234abcd <context>`.",
  };
}

async function findingTarget(
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  findingId: string,
): Promise<{ entry?: FindingLedgerEntry; reason?: string }> {
  return persistence.withTransaction(key, async (transaction) => {
    const entries = (await transaction.loadLedger())?.entries ?? [];
    const matches = entries.filter(
      (entry) => findingShortIdentityFromFingerprint(entry.fingerprint).toUpperCase() === findingId,
    );
    if (matches.length === 0) return { reason: `Finding identity ${findingId} is unknown.` };
    if (matches.length > 1) return { reason: `Finding identity ${findingId} is ambiguous.` };
    const entry = matches[0]!;
    if (
      entry.reviewedHeadSha === undefined ||
      !["new", "persisting", "accepted", "rebutted", "suppressed"].includes(entry.lifecycleState)
    ) {
      return { reason: `Finding identity ${findingId} is stale.` };
    }
    return { entry };
  });
}

export interface PullRequestCommandContext {
  command: RoutedCommand;
  workType: CommandWorkType;
  findingFingerprint?: string | undefined;
  findingContext?: string | undefined;
  rootCommentId?: string | undefined;
  reviewedHeadSha?: string | undefined;
  discussionEvent?: FindingDiscussionEvent | undefined;
  reason?: string | undefined;
}

export async function resolvePullRequestCommand(
  command: PullRequestCommand,
  persistence: ReviewPersistenceStore,
  key: PullRequestPersistenceKey,
  event: { eventId: string; actor: string },
  headSha: string,
  observedAt: string,
): Promise<PullRequestCommandContext> {
  if (command.type === "review") {
    return { command: "review", workType: "full_review" };
  }
  if (command.type === "malformed_finding") {
    return {
      command: "review",
      workType: "full_review",
      reason: command.reason,
    };
  }
  const target = await findingTarget(persistence, key, command.findingId);
  const entry = target.entry;
  if (entry === undefined) {
    return {
      command: command.command,
      workType: "full_review",
      rootCommentId: event.eventId,
      reason: target.reason,
    };
  }
  return {
    command: command.command,
    workType: entry.reviewedHeadSha === headSha ? "finding_discussion" : "full_review",
    findingFingerprint: entry.fingerprint,
    ...(command.context === undefined ? {} : { findingContext: command.context }),
    rootCommentId: event.eventId,
    reviewedHeadSha: entry.reviewedHeadSha,
    discussionEvent: {
      id: event.eventId,
      fingerprint: entry.fingerprint,
      actor: event.actor,
      command: command.command,
      createdAt: observedAt,
      ...(command.context === undefined ? {} : { body: command.context }),
      source: "issue_comment",
    },
  };
}
