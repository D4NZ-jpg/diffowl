/* oxlint-disable max-lines */
import { isJsonObject, requireJsonVersion } from "./canonical-json.js";
import {
  parseFindingDiscussionEvent,
  type FindingDiscussionCommand,
  type FindingDiscussionEvent,
} from "./finding-discussion.js";
import type { FindingLifecycleState } from "./review-orchestration.js";

export const FINDING_LEDGER_VERSION = 1;

export type FindingDispositionState = "accepted" | "rebutted" | "suppressed";
export type { FindingDiscussionCommand, FindingDiscussionEvent };
export type ReviewCompletion = "completed_permitted" | "incomplete";

export interface LedgerSuggestedPatch {
  identity: string;
  reviewedHeadSha: string;
  validity: "validated" | "invalidated";
}

export interface LedgerFindingSnapshot {
  fingerprint: string;
  summary: string;
  locationPath?: string | undefined;
  locationLine?: number | undefined;
  reviewedHeadSha?: string | undefined;
  suggestedPatch?: LedgerSuggestedPatch | undefined;
}

export interface FindingLedgerEntry extends LedgerFindingSnapshot {
  lifecycleState: FindingLifecycleState;
  firstSeenRunId: string;
  lastChangedRunId: string;
  lastSeenRunId?: string | undefined;
  resolvedAtRunId?: string | undefined;
  obsoleteAtRunId?: string | undefined;
  discussion?: FindingDiscussionEvent[] | undefined;
}

export interface FindingLedger {
  version: typeof FINDING_LEDGER_VERSION;
  entries: FindingLedgerEntry[];
}

export interface FindingLedgerReconciliationInput {
  previous?: FindingLedger | undefined;
  runId: string;
  completion: ReviewCompletion;
  materialFindings: LedgerFindingSnapshot[];
  suppressedFindings?: LedgerFindingSnapshot[] | undefined;
  dispositions?: Readonly<Record<string, FindingDispositionState>> | undefined;
  obsoleteFingerprints?: readonly string[] | undefined;
  resolvedFingerprints?: readonly string[] | undefined;
  reassessments?: readonly string[] | undefined;
  discussionEvents?: readonly FindingDiscussionEvent[] | undefined;
}

const lifecycleStates = new Set<FindingLifecycleState>([
  "new",
  "persisting",
  "resolved",
  "obsolete",
  "rebutted",
  "accepted",
  "suppressed",
]);

function byFingerprint(ledger: FindingLedger | undefined): Map<string, FindingLedgerEntry> {
  return new Map((ledger?.entries ?? []).map((entry) => [entry.fingerprint, entry]));
}

function currentSuggestedPatch(
  snapshot: LedgerFindingSnapshot,
  entry?: FindingLedgerEntry,
): LedgerSuggestedPatch | undefined {
  if (snapshot.suggestedPatch !== undefined) return snapshot.suggestedPatch;
  return entry?.suggestedPatch === undefined
    ? undefined
    : { ...entry.suggestedPatch, validity: "invalidated" };
}

function currentSnapshot(
  snapshot: LedgerFindingSnapshot,
  entry?: FindingLedgerEntry,
): LedgerFindingSnapshot {
  return {
    fingerprint: snapshot.fingerprint,
    summary: snapshot.summary || entry?.summary || "",
    locationPath: snapshot.locationPath ?? entry?.locationPath,
    locationLine: snapshot.locationLine ?? entry?.locationLine,
    reviewedHeadSha: snapshot.reviewedHeadSha ?? entry?.reviewedHeadSha,
    suggestedPatch: currentSuggestedPatch(snapshot, entry),
  };
}

function disposedMaterialState(
  previous: FindingLedgerEntry,
  current: LedgerFindingSnapshot,
  reassessing: boolean,
): FindingLifecycleState | undefined {
  if (previous.lifecycleState === "accepted") return reassessing ? "persisting" : "accepted";
  if (previous.lifecycleState !== "rebutted" && previous.lifecycleState !== "suppressed") {
    return undefined;
  }
  const newerReviewedHead =
    previous.reviewedHeadSha !== undefined &&
    current.reviewedHeadSha !== undefined &&
    previous.reviewedHeadSha !== current.reviewedHeadSha;
  return reassessing || newerReviewedHead ? "persisting" : previous.lifecycleState;
}

function observedMaterialState(
  previous: FindingLedgerEntry | undefined,
  current: LedgerFindingSnapshot,
  disposition: FindingDispositionState | undefined,
  reassessing: boolean,
): FindingLifecycleState {
  if (disposition !== undefined) return disposition;
  if (
    previous === undefined ||
    previous.lifecycleState === "resolved" ||
    previous.lifecycleState === "obsolete"
  ) {
    return "new";
  }
  return disposedMaterialState(previous, current, reassessing) ?? "persisting";
}

function activeFindingState(state: FindingLifecycleState): boolean {
  return state === "new" || state === "persisting" || state === "accepted";
}

function observedSuppressedState(
  previous: FindingLedgerEntry | undefined,
  disposition: FindingDispositionState | undefined,
  reassessing: boolean,
): FindingLifecycleState {
  if (disposition !== undefined) return disposition;
  if (previous?.lifecycleState === "accepted" || previous?.lifecycleState === "rebutted") {
    return reassessing ? "suppressed" : previous.lifecycleState;
  }
  return "suppressed";
}

function transition(
  previous: FindingLedgerEntry,
  lifecycleState: FindingLifecycleState,
  runId: string,
  discussion?: FindingDiscussionEvent[],
): FindingLedgerEntry {
  const changed = lifecycleState !== previous.lifecycleState;
  return {
    ...previous,
    lifecycleState,
    lastChangedRunId: changed ? runId : previous.lastChangedRunId,
    resolvedAtRunId: lifecycleState === "resolved" && changed ? runId : previous.resolvedAtRunId,
    obsoleteAtRunId: lifecycleState === "obsolete" && changed ? runId : previous.obsoleteAtRunId,
    ...(discussion === undefined ? {} : { discussion }),
  };
}

function observedEntry(
  snapshot: LedgerFindingSnapshot,
  previous: FindingLedgerEntry | undefined,
  lifecycleState: FindingLifecycleState,
  runId: string,
): FindingLedgerEntry {
  const current = currentSnapshot(snapshot, previous);
  const base: FindingLedgerEntry = previous ?? {
    ...current,
    lifecycleState,
    firstSeenRunId: runId,
    lastChangedRunId: runId,
  };
  return {
    ...transition({ ...base, ...current }, lifecycleState, runId, previous?.discussion),
    lastSeenRunId: runId,
  };
}

function observedFindingEntry(
  snapshot: LedgerFindingSnapshot,
  previous: FindingLedgerEntry | undefined,
  state: FindingLifecycleState,
  runId: string,
): FindingLedgerEntry {
  const observed = observedEntry(snapshot, previous, state, runId);
  return activeFindingState(state) ? observed : invalidatedPatchEntry(observed);
}

function assertUniqueSnapshots(snapshots: readonly LedgerFindingSnapshot[], noun: string): void {
  const fingerprints = new Set<string>();
  for (const snapshot of snapshots) {
    if (fingerprints.has(snapshot.fingerprint)) {
      throw new Error(`${noun} contains duplicate fingerprint "${snapshot.fingerprint}".`);
    }
    fingerprints.add(snapshot.fingerprint);
  }
}

function discussionByFingerprint(
  events: readonly FindingDiscussionEvent[],
): Map<string, FindingDiscussionEvent[]> {
  const byFinding = new Map<string, FindingDiscussionEvent[]>();
  for (const event of events) {
    const prior = byFinding.get(event.fingerprint) ?? [];
    byFinding.set(event.fingerprint, [...prior, event]);
  }
  return byFinding;
}

function appendedDiscussion(
  entry: FindingLedgerEntry,
  events: FindingDiscussionEvent[] | undefined,
): FindingDiscussionEvent[] | undefined {
  if (events === undefined || events.length === 0) return entry.discussion;
  const existing = entry.discussion ?? [];
  const ids = new Set(existing.map((event) => event.id));
  return [...existing, ...events.filter((event) => !ids.has(event.id))];
}

function invalidatedPatchEntry(entry: FindingLedgerEntry): FindingLedgerEntry {
  return entry.suggestedPatch === undefined
    ? entry
    : {
        ...entry,
        suggestedPatch: { ...entry.suggestedPatch, validity: "invalidated" },
      };
}

function explicitUnobservedState(
  entry: FindingLedgerEntry,
  input: FindingLedgerReconciliationInput,
  obsolete: ReadonlySet<string>,
  resolved: ReadonlySet<string>,
): FindingLifecycleState | undefined {
  return (
    input.dispositions?.[entry.fingerprint] ??
    (resolved.has(entry.fingerprint)
      ? "resolved"
      : obsolete.has(entry.fingerprint)
        ? "obsolete"
        : undefined)
  );
}

function unobservedEntry(
  entry: FindingLedgerEntry,
  input: FindingLedgerReconciliationInput,
  obsolete: ReadonlySet<string>,
  resolved: ReadonlySet<string>,
): FindingLedgerEntry {
  const explicitState = explicitUnobservedState(entry, input, obsolete, resolved);
  if (explicitState !== undefined) {
    const updated = transition(entry, explicitState, input.runId);
    return ["rebutted", "suppressed", "resolved", "obsolete"].includes(explicitState)
      ? invalidatedPatchEntry(updated)
      : updated;
  }
  const active = entry.lifecycleState === "new" || entry.lifecycleState === "persisting";
  const reassessing = input.reassessments?.includes(entry.fingerprint) === true;
  return input.completion === "completed_permitted" && (active || reassessing)
    ? invalidatedPatchEntry(transition(entry, "resolved", input.runId))
    : entry;
}

// oxlint-disable-next-line complexity
export function reconcileFindingLedger(input: FindingLedgerReconciliationInput): FindingLedger {
  if (input.runId.length === 0) throw new Error("Finding ledger run id must not be empty.");
  assertUniqueSnapshots(input.materialFindings, "Material findings");
  assertUniqueSnapshots(input.suppressedFindings ?? [], "Suppressed findings");

  const previous = byFingerprint(input.previous);
  const next = new Map<string, FindingLedgerEntry>();
  const reassessments = new Set(input.reassessments ?? []);
  const obsolete = new Set(input.obsoleteFingerprints ?? []);
  const resolved = new Set(input.resolvedFingerprints ?? []);
  const discussion = discussionByFingerprint(input.discussionEvents ?? []);
  const suppressed = new Map(
    (input.suppressedFindings ?? []).map((snapshot) => [snapshot.fingerprint, snapshot]),
  );
  const material = new Map(
    input.materialFindings.map((snapshot) => [snapshot.fingerprint, snapshot]),
  );
  for (const fingerprint of suppressed.keys()) {
    if (material.has(fingerprint))
      throw new Error(`Finding "${fingerprint}" cannot be material and suppressed.`);
  }

  for (const [fingerprint, snapshot] of material) {
    const prior = previous.get(fingerprint);
    const state = observedMaterialState(
      prior,
      snapshot,
      input.dispositions?.[fingerprint],
      reassessments.has(fingerprint),
    );
    next.set(fingerprint, observedFindingEntry(snapshot, prior, state, input.runId));
  }
  for (const [fingerprint, snapshot] of suppressed) {
    const prior = previous.get(fingerprint);
    const state = observedSuppressedState(
      prior,
      input.dispositions?.[fingerprint],
      reassessments.has(fingerprint),
    );
    next.set(fingerprint, observedFindingEntry(snapshot, prior, state, input.runId));
  }

  for (const entry of previous.values()) {
    if (!next.has(entry.fingerprint)) {
      next.set(entry.fingerprint, unobservedEntry(entry, input, obsolete, resolved));
    }
  }
  for (const [fingerprint, events] of discussion) {
    const entry = next.get(fingerprint);
    if (entry !== undefined) {
      next.set(fingerprint, { ...entry, discussion: appendedDiscussion(entry, events) });
    }
  }
  return { version: FINDING_LEDGER_VERSION, entries: [...next.values()] };
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

function parseDiscussion(value: unknown): FindingDiscussionEvent[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("Finding discussion must be an array.");
  return value.map(parseFindingDiscussionEvent);
}

function parseSuggestedPatch(value: unknown): LedgerSuggestedPatch | undefined {
  if (value === undefined) return undefined;
  if (
    !isJsonObject(value) ||
    typeof value.identity !== "string" ||
    !/^sha256:[\da-f]{64}$/u.test(value.identity) ||
    typeof value.reviewedHeadSha !== "string" ||
    value.reviewedHeadSha.length === 0 ||
    (value.validity !== "validated" && value.validity !== "invalidated")
  ) {
    throw new Error("Finding ledger Suggested patch is invalid.");
  }
  return value as unknown as LedgerSuggestedPatch;
}

// oxlint-disable-next-line complexity
function parseEntry(value: unknown): FindingLedgerEntry {
  if (!isJsonObject(value)) throw new Error("Finding ledger entry must be an object.");
  if (
    typeof value.fingerprint !== "string" ||
    value.fingerprint.length === 0 ||
    typeof value.summary !== "string" ||
    !optionalString(value.locationPath) ||
    (value.locationLine !== undefined &&
      (!Number.isInteger(value.locationLine) || Number(value.locationLine) <= 0)) ||
    !optionalString(value.reviewedHeadSha) ||
    !lifecycleStates.has(value.lifecycleState as FindingLifecycleState) ||
    typeof value.firstSeenRunId !== "string" ||
    value.firstSeenRunId.length === 0 ||
    typeof value.lastChangedRunId !== "string" ||
    value.lastChangedRunId.length === 0 ||
    !optionalString(value.lastSeenRunId) ||
    !optionalString(value.resolvedAtRunId) ||
    !optionalString(value.obsoleteAtRunId)
  ) {
    throw new Error("Finding ledger entry is invalid.");
  }
  return {
    ...(value as unknown as FindingLedgerEntry),
    discussion: parseDiscussion(value.discussion),
    suggestedPatch: parseSuggestedPatch(value.suggestedPatch),
  };
}

export function parseFindingLedger(value: unknown): FindingLedger {
  requireJsonVersion(value, FINDING_LEDGER_VERSION, "Finding ledger");
  if (!Array.isArray(value.entries)) throw new Error("Finding ledger entries must be an array.");
  const entries = value.entries.map(parseEntry);
  const fingerprints = new Set(entries.map((entry) => entry.fingerprint));
  if (fingerprints.size !== entries.length) {
    throw new Error("Finding ledger contains duplicate fingerprints.");
  }
  return { version: FINDING_LEDGER_VERSION, entries };
}
