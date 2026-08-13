/* oxlint-disable max-lines-per-function */
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reconcileFindingLedger } from "../src/finding-ledger.js";
import { FileSystemReviewPersistenceStore } from "../src/persistence.js";
import { createReviewRunRecord, type ReviewRunRecord } from "../src/review-run-record.js";
import {
  completedReviewOutcome,
  projectPolicy,
  reviewedPullRequest,
  trustedSameRepoTrust,
} from "./review-fixtures.js";

const temporaryDirectories: string[] = [];
const key = { repository: reviewedPullRequest.repository, pullRequestNumber: 42 };

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "diffowl-persistence-"));
  temporaryDirectories.push(root);
  return root;
}

function runRecord(runId: string): ReviewRunRecord {
  const policy = projectPolicy();
  return createReviewRunRecord({
    runId,
    recordedAt: "2026-01-02T03:04:05.000Z",
    engineVersion: "0.1.0-test",
    revision: { pullRequest: reviewedPullRequest, mergeBaseSha: reviewedPullRequest.baseSha },
    trust: trustedSameRepoTrust,
    policy,
    validationAttempts: [],
    finalOutcome: completedReviewOutcome({
      trust: trustedSameRepoTrust,
      policy,
      policySource: {
        type: "trusted_base_branch",
        revision: reviewedPullRequest.baseSha,
        path: ".diffowl.json",
      },
      verification: {
        evidenceCatalog: [],
        validationAttempts: [],
        limitations: [],
        coverageGaps: [],
      },
    }) as never,
  });
}

function ledger(runId = "run-1") {
  return reconcileFindingLedger({
    runId,
    completion: "completed_permitted",
    materialFindings: [{ fingerprint: "fp", summary: "Finding", locationPath: "src/a.ts" }],
  });
}

describe("FileSystemReviewPersistenceStore", () => {
  it("atomically persists ledgers and immutable run records", async () => {
    const store = new FileSystemReviewPersistenceStore(await temporaryRoot());
    await store.withTransaction(key, async (transaction) => {
      await transaction.saveLedger(ledger());
      await transaction.saveRunRecord(runRecord("run-1"));
    });
    await store.withTransaction(key, async (transaction) => {
      expect(await transaction.loadLedger()).toEqual(ledger());
      expect(await transaction.loadRunRecord("run-1")).toMatchObject({
        version: 1,
        runId: "run-1",
      });
      await transaction.saveRunRecord(runRecord("run-1"));
    });
    await expect(
      store.withTransaction(key, async (transaction) => {
        await transaction.saveRunRecord({ ...runRecord("run-1"), engineVersion: "changed" });
      }),
    ).rejects.toThrow("immutable");
  });

  it("rolls back all staged changes when a callback fails", async () => {
    const store = new FileSystemReviewPersistenceStore(await temporaryRoot());
    await expect(
      store.withTransaction(key, async (transaction) => {
        await transaction.saveLedger(ledger());
        await transaction.saveRunRecord(runRecord("run-1"));
        throw new Error("fault injection");
      }),
    ).rejects.toThrow("fault injection");
    await store.withTransaction(key, async (transaction) => {
      expect(await transaction.loadLedger()).toBeUndefined();
      expect(await transaction.loadRunRecord("run-1")).toBeUndefined();
    });
  });

  it("serializes three transactions without stealing a long-running lock", async () => {
    const store = new FileSystemReviewPersistenceStore(await temporaryRoot(), 2_000);
    const events: string[] = [];
    let signalFirstStarted: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      signalFirstStarted = resolveStarted;
    });
    const transaction = (name: string, delay: number) =>
      store.withTransaction(key, async () => {
        events.push(`${name}-start`);
        if (name === "first") signalFirstStarted();
        await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
        events.push(`${name}-end`);
      });
    const first = transaction("first", 100);
    await firstStarted;
    await Promise.all([first, transaction("second", 10), transaction("third", 10)]);
    expect(events[0]).toBe("first-start");
    expect(events[1]).toBe("first-end");
    expect(events.slice(2)).toEqual(
      expect.arrayContaining(["second-start", "second-end", "third-start", "third-end"]),
    );
    expect(events.indexOf("second-end") - events.indexOf("second-start")).toBe(1);
    expect(events.indexOf("third-end") - events.indexOf("third-start")).toBe(1);
  });

  it("recovers abandoned locks but never steals a live process lock", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "repositories", "example", "review-target", "pull-requests", "42");
    const lock = `${directory}.lock`;
    await mkdir(lock, { recursive: true });
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ token: "dead", pid: 2_147_483_647 }),
    );
    await new FileSystemReviewPersistenceStore(root, 500).withTransaction(key, async () => {});

    await mkdir(lock, { recursive: true });
    await writeFile(join(lock, "owner.json"), JSON.stringify({ token: "live", pid: process.pid }));
    await expect(
      new FileSystemReviewPersistenceStore(root, 100).withTransaction(key, async () => {}),
    ).rejects.toThrow("Timed out acquiring persistence lock");
  });

  it("rejects traversal and symbolic-link roots, and tightens root permissions", async () => {
    const root = await temporaryRoot();
    await chmod(root, 0o777);
    const store = new FileSystemReviewPersistenceStore(root);
    await expect(
      store.withTransaction({ repository: "owner/../repo", pullRequestNumber: 1 }, async () => {}),
    ).rejects.toThrow("owner/name");
    await expect(
      store.withTransaction(key, async (transaction) => transaction.loadRunRecord("../outside")),
    ).rejects.toThrow("unsafe path segment");

    const target = await temporaryRoot();
    const link = join(await temporaryRoot(), "linked-root");
    await symlink(target, link);
    await expect(
      new FileSystemReviewPersistenceStore(link).withTransaction(key, async () => {}),
    ).rejects.toThrow("symbolic");
  });

  it("rejects corrupt persisted manifests", async () => {
    const root = await temporaryRoot();
    const directory = join(root, "repositories", "example", "review-target", "pull-requests", "42");
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "manifest.json"), '{"version":1,"runs":{"x":"../escape"}}');

    const store = new FileSystemReviewPersistenceStore(root);
    await expect(store.withTransaction(key, async () => {})).rejects.toThrow(
      "Persistence manifest is invalid",
    );
  });
});
