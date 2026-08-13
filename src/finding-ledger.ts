import { isJsonObject, requireJsonVersion } from "./canonical-json.js";
import type { FindingLifecycleState } from "./review-orchestration.js";

export const FINDING_LEDGER_VERSION = 1;

export type FindingDispositionState = "accepted" | "rebutted" | "suppressed";
export type ReviewCompletion = "completed_permitted" | "incomplete";

export interface LedgerFindingSnapshot {
  fingerprint: string;
  summary: string;
  locationPath?: string | undefined;
}

export interface FindingLedgerEntry extends LedgerFindingSnapshot {
  lifecycleState: FindingLifecycleState;
  firstSeenRunId: string;
  lastChangedRunId: string;
  lastSeenRunId?: string | undefined;
  resolvedAtRunId?: string | undefined;
  obsoleteAtRunId?: string | undefined;
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
  reassessments?: readonly string[] | undefined;
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

function currentSnapshot(
  snapshot: LedgerFindingSnapshot,
  entry?: FindingLedgerEntry,
): LedgerFindingSnapshot {
  return {
    fingerprint: snapshot.fingerprint,
    summary: snapshot.summary || entry?.summary || "",
    locationPath: snapshot.locationPath ?? entry?.locationPath,
  };
}

function manuallyDisposed(state: FindingLifecycleState): state is FindingDispositionState {
  return state === "accepted" || state === "rebutted" || state === "suppressed";
}

function observedMaterialState(
  previous: FindingLedgerEntry | undefined,
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
  if (manuallyDisposed(previous.lifecycleState)) {
    return reassessing ? "persisting" : previous.lifecycleState;
  }
  return "persisting";
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
): FindingLedgerEntry {
  const changed = lifecycleState !== previous.lifecycleState;
  return {
    ...previous,
    lifecycleState,
    lastChangedRunId: changed ? runId : previous.lastChangedRunId,
    resolvedAtRunId: lifecycleState === "resolved" && changed ? runId : previous.resolvedAtRunId,
    obsoleteAtRunId: lifecycleState === "obsolete" && changed ? runId : previous.obsoleteAtRunId,
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
    ...transition({ ...base, ...current }, lifecycleState, runId),
    lastSeenRunId: runId,
  };
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

// oxlint-disable-next-line complexity
export function reconcileFindingLedger(input: FindingLedgerReconciliationInput): FindingLedger {
  if (input.runId.length === 0) throw new Error("Finding ledger run id must not be empty.");
  assertUniqueSnapshots(input.materialFindings, "Material findings");
  assertUniqueSnapshots(input.suppressedFindings ?? [], "Suppressed findings");

  const previous = byFingerprint(input.previous);
  const next = new Map<string, FindingLedgerEntry>();
  const reassessments = new Set(input.reassessments ?? []);
  const obsolete = new Set(input.obsoleteFingerprints ?? []);
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
      input.dispositions?.[fingerprint],
      reassessments.has(fingerprint),
    );
    next.set(fingerprint, observedEntry(snapshot, prior, state, input.runId));
  }
  for (const [fingerprint, snapshot] of suppressed) {
    const prior = previous.get(fingerprint);
    const state = observedSuppressedState(
      prior,
      input.dispositions?.[fingerprint],
      reassessments.has(fingerprint),
    );
    next.set(fingerprint, observedEntry(snapshot, prior, state, input.runId));
  }

  for (const entry of previous.values()) {
    if (next.has(entry.fingerprint)) continue;
    const disposition = input.dispositions?.[entry.fingerprint];
    if (disposition !== undefined) {
      next.set(entry.fingerprint, transition(entry, disposition, input.runId));
    } else if (obsolete.has(entry.fingerprint)) {
      next.set(entry.fingerprint, transition(entry, "obsolete", input.runId));
    } else if (
      input.completion === "completed_permitted" &&
      (entry.lifecycleState === "new" || entry.lifecycleState === "persisting")
    ) {
      next.set(entry.fingerprint, transition(entry, "resolved", input.runId));
    } else {
      next.set(entry.fingerprint, entry);
    }
  }
  return { version: FINDING_LEDGER_VERSION, entries: [...next.values()] };
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

// oxlint-disable-next-line complexity
function parseEntry(value: unknown): FindingLedgerEntry {
  if (!isJsonObject(value)) throw new Error("Finding ledger entry must be an object.");
  if (
    typeof value.fingerprint !== "string" ||
    value.fingerprint.length === 0 ||
    typeof value.summary !== "string" ||
    !optionalString(value.locationPath) ||
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
  return value as unknown as FindingLedgerEntry;
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
