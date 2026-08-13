import { expect, it } from "vitest";

import {
  parseFindingLedger,
  reconcileFindingLedger,
  type FindingLedger,
  type LedgerFindingSnapshot,
} from "../src/finding-ledger.js";

function finding(fingerprint: string): LedgerFindingSnapshot {
  return { fingerprint, summary: `Finding ${fingerprint}`, locationPath: `src/${fingerprint}.ts` };
}

function ledger(entries: FindingLedger["entries"]): FindingLedger {
  return { version: 1, entries };
}

function activeEntry(fingerprint: string, lifecycleState: "new" | "persisting" = "persisting") {
  return {
    ...finding(fingerprint),
    lifecycleState,
    firstSeenRunId: "run-1",
    lastChangedRunId: "run-1",
    lastSeenRunId: "run-1",
  };
}

it("marks first-seen and repeated findings", () => {
  const first = reconcileFindingLedger({
    runId: "run-1",
    completion: "completed_permitted",
    materialFindings: [finding("a")],
  });
  const second = reconcileFindingLedger({
    previous: first,
    runId: "run-2",
    completion: "completed_permitted",
    materialFindings: [finding("a"), finding("b")],
  });

  expect(second.entries).toEqual([
    expect.objectContaining({
      fingerprint: "a",
      lifecycleState: "persisting",
      firstSeenRunId: "run-1",
      lastChangedRunId: "run-2",
      lastSeenRunId: "run-2",
    }),
    expect.objectContaining({ fingerprint: "b", lifecycleState: "new", firstSeenRunId: "run-2" }),
  ]);
});

it("preserves active findings during incomplete reviews", () => {
  const next = reconcileFindingLedger({
    previous: ledger([activeEntry("a")]),
    runId: "run-2",
    completion: "incomplete",
    materialFindings: [],
  });

  expect(next.entries[0]).toMatchObject({ fingerprint: "a", lifecycleState: "persisting" });
  expect(next.entries[0]).not.toHaveProperty("obsoleteAtRunId");
});

it("resolves only after completed coverage and obsoletes only with explicit evidence", () => {
  const previous = ledger([activeEntry("resolved"), activeEntry("obsolete")]);
  const next = reconcileFindingLedger({
    previous,
    runId: "run-2",
    completion: "completed_permitted",
    materialFindings: [],
    obsoleteFingerprints: ["obsolete"],
  });

  expect(next.entries).toEqual([
    expect.objectContaining({
      fingerprint: "resolved",
      lifecycleState: "resolved",
      resolvedAtRunId: "run-2",
    }),
    expect.objectContaining({
      fingerprint: "obsolete",
      lifecycleState: "obsolete",
      obsoleteAtRunId: "run-2",
    }),
  ]);
});

it("applies out-of-band dispositions to existing findings and preserves terminal run ids", () => {
  const accepted = reconcileFindingLedger({
    previous: ledger([activeEntry("a")]),
    runId: "run-2",
    completion: "incomplete",
    materialFindings: [],
    dispositions: { a: "accepted" },
  });
  expect(accepted.entries[0]).toMatchObject({
    lifecycleState: "accepted",
    lastChangedRunId: "run-2",
  });

  const resolved = reconcileFindingLedger({
    previous: ledger([
      { ...activeEntry("r"), lifecycleState: "resolved", resolvedAtRunId: "run-2" },
    ]),
    runId: "run-3",
    completion: "completed_permitted",
    materialFindings: [],
  });
  expect(resolved.entries[0]).toMatchObject({
    resolvedAtRunId: "run-2",
    lastChangedRunId: "run-1",
  });
});

it("preserves accepted or rebutted findings when suppressed observations arrive", () => {
  const previous = ledger([
    { ...activeEntry("accepted"), lifecycleState: "accepted" },
    { ...activeEntry("rebutted"), lifecycleState: "rebutted" },
  ]);
  const preserved = reconcileFindingLedger({
    previous,
    runId: "run-2",
    completion: "completed_permitted",
    materialFindings: [],
    suppressedFindings: [finding("accepted"), finding("rebutted")],
  });
  expect(preserved.entries.map((entry) => entry.lifecycleState)).toEqual(["accepted", "rebutted"]);

  const reassessed = reconcileFindingLedger({
    previous,
    runId: "run-3",
    completion: "completed_permitted",
    materialFindings: [],
    suppressedFindings: [finding("accepted"), finding("rebutted")],
    reassessments: ["accepted"],
    dispositions: { rebutted: "suppressed" },
  });
  expect(reassessed.entries.map((entry) => entry.lifecycleState)).toEqual([
    "suppressed",
    "suppressed",
  ]);
});

it("reassesses manual dispositions only when explicitly requested", () => {
  const previous = ledger([
    { ...activeEntry("accepted"), lifecycleState: "accepted" },
    { ...activeEntry("rebutted"), lifecycleState: "rebutted" },
    { ...activeEntry("suppressed"), lifecycleState: "suppressed" },
  ]);
  const preserved = reconcileFindingLedger({
    previous,
    runId: "run-2",
    completion: "completed_permitted",
    materialFindings: [finding("accepted"), finding("rebutted"), finding("suppressed")],
  });
  expect(preserved.entries.map((entry) => entry.lifecycleState)).toEqual([
    "accepted",
    "rebutted",
    "suppressed",
  ]);

  const reassessed = reconcileFindingLedger({
    previous,
    runId: "run-3",
    completion: "completed_permitted",
    materialFindings: [finding("accepted"), finding("rebutted"), finding("suppressed")],
    reassessments: ["accepted", "rebutted", "suppressed"],
  });
  expect(reassessed.entries.map((entry) => entry.lifecycleState)).toEqual([
    "persisting",
    "persisting",
    "persisting",
  ]);

  const resolved = reconcileFindingLedger({
    previous,
    runId: "run-4",
    completion: "completed_permitted",
    materialFindings: [],
    reassessments: ["accepted", "rebutted", "suppressed"],
  });
  expect(resolved.entries.map((entry) => entry.lifecycleState)).toEqual([
    "resolved",
    "resolved",
    "resolved",
  ]);
});

it("records audited discussion events and resolved author dispositions", () => {
  const next = reconcileFindingLedger({
    previous: ledger([activeEntry("a")]),
    runId: "run-2",
    completion: "incomplete",
    materialFindings: [],
    resolvedFingerprints: ["a"],
    discussionEvents: [
      {
        id: "comment-1",
        fingerprint: "a",
        actor: "author",
        command: "resolved",
        body: "fixed in the latest push",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ],
  });

  expect(next.entries[0]).toMatchObject({
    lifecycleState: "resolved",
    discussion: [
      expect.objectContaining({ command: "resolved", body: "fixed in the latest push" }),
    ],
  });
});

it("rejects corrupt ledgers", () => {
  expect(() => parseFindingLedger({ version: 2, entries: [] })).toThrow("version must be 1");
  expect(() => parseFindingLedger({ version: 1, entries: [{ fingerprint: "x" }] })).toThrow(
    "entry is invalid",
  );
  const entry = activeEntry("duplicate");
  expect(() => parseFindingLedger({ version: 1, entries: [entry, entry] })).toThrow(
    "duplicate fingerprints",
  );
});
