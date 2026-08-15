/* oxlint-disable max-lines, max-lines-per-function */
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { reconcileFindingLedger } from "../src/finding-ledger.js";
import { GitReviewPersistenceStore } from "../src/git-state-persistence.js";
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

function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error === null) resolve(stdout.trimEnd());
      else reject(new Error(stderr.trim() || error.message));
    });
  });
}

async function temporaryGitRepository(): Promise<{ remote: string; checkout: string }> {
  const root = await temporaryRoot();
  const remote = join(root, "remote.git");
  const checkout = join(root, "checkout");
  await git(["init", "--bare", remote], root);
  await git(["clone", remote, checkout], root);
  await git(["config", "user.email", "review-owl@example.invalid"], checkout);
  await git(["config", "user.name", "Review OWL"], checkout);
  await writeFile(join(checkout, "README.md"), "# target\n");
  await git(["add", "README.md"], checkout);
  await git(["commit", "-m", "initial"], checkout);
  await git(["push", "origin", "HEAD:main"], checkout);
  return { remote, checkout };
}

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
      await transaction.savePublicationEffects("run-1", { result: "complete" });
      await transaction.savePublicationState({ version: 1, effectOwners: {} });
    });
    await store.withTransaction(key, async (transaction) => {
      expect(await transaction.loadLedger()).toEqual(ledger());
      expect(await transaction.loadRunRecord("run-1")).toMatchObject({
        version: 1,
        runId: "run-1",
      });
      expect(await transaction.loadPublicationEffects("run-1")).toEqual({ result: "complete" });
      expect(await transaction.loadPublicationState()).toEqual({ version: 1, effectOwners: {} });
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

// jscpd:ignore-start
describe("GitReviewPersistenceStore", () => {
  it("persists ledgers and immutable run records through a dedicated Git ref", async () => {
    const { checkout } = await temporaryGitRepository();
    const store = new GitReviewPersistenceStore({ gitDirectory: checkout });

    await store.prepare(key);
    await store.withTransaction(key, async (transaction) => {
      await transaction.saveLedger(ledger());
      await transaction.saveRunRecord(runRecord("run-1"));
      await transaction.savePublicationEffects("run-1", { result: "complete" });
      await transaction.savePublicationState({ version: 1, effectOwners: {} });
      await transaction.saveReviewRequests({
        version: 1,
        events: {
          command: {
            eventId: "command",
            actor: "author",
            command: "review",
            deprecatedAlias: false,
            observedAt: "2026-08-15T00:00:00.000Z",
            headSha: reviewedPullRequest.headSha,
            decision: "dispatch",
            requestId: "command",
          },
        },
        requests: {
          command: {
            requestId: "command",
            headSha: reviewedPullRequest.headSha,
            status: "queued",
            requestedAt: "2026-08-15T00:00:00.000Z",
          },
        },
      });
    });
    await store.withTransaction(key, async (transaction) => {
      expect(await transaction.loadLedger()).toEqual(ledger());
      expect(await transaction.loadRunRecord("run-1")).toMatchObject({ runId: "run-1" });
      expect(await transaction.loadPublicationEffects("run-1")).toEqual({ result: "complete" });
      expect(await transaction.loadPublicationState()).toEqual({ version: 1, effectOwners: {} });
      expect(await transaction.loadReviewRequests()).toMatchObject({
        events: { command: { decision: "dispatch" } },
        requests: { command: { status: "queued" } },
      });
      await transaction.saveRunRecord(runRecord("run-1"));
    });
    await expect(
      store.withTransaction(key, async (transaction) => {
        await transaction.saveRunRecord({ ...runRecord("run-1"), engineVersion: "changed" });
      }),
    ).rejects.toThrow("immutable");

    const stateRef = "refs/diffowl/state/repositories/example/review-target/pull-requests/42/state";
    const markerRef =
      "refs/diffowl/state/repositories/example/review-target/pull-requests/42/marker";
    expect(await git(["ls-remote", "origin", stateRef], checkout)).toContain(stateRef);
    expect(await git(["ls-remote", "origin", markerRef], checkout)).toContain(markerRef);
  }, 60_000);

  it("rereads and reconciles one Git conflict, then preserves both transitions", async () => {
    const { remote, checkout } = await temporaryGitRepository();
    const secondCheckout = join(await temporaryRoot(), "second-checkout");
    await git(["clone", "--branch", "main", remote, secondCheckout], checkout);
    const stores = [
      new GitReviewPersistenceStore({ gitDirectory: checkout }),
      new GitReviewPersistenceStore({ gitDirectory: secondCheckout }),
    ];
    const attempts = [0, 0];
    let arrivals = 0;
    let release: (() => void) | undefined;
    const bothLoaded = new Promise<void>((resolve) => {
      release = resolve;
    });

    await Promise.all(
      stores.map((store, index) =>
        store.withTransaction(key, async (transaction) => {
          attempts[index] = (attempts[index] ?? 0) + 1;
          if (attempts[index] === 1) {
            arrivals += 1;
            if (arrivals === 2) release?.();
            await bothLoaded;
          }
          await transaction.savePublicationEffects(`run-${index + 1}`, {
            result: "complete",
          });
        }),
      ),
    );

    expect(attempts).toContain(2);
    await new GitReviewPersistenceStore({ gitDirectory: checkout }).withTransaction(
      key,
      async (transaction) => {
        expect(await transaction.loadPublicationEffects("run-1")).toEqual({
          result: "complete",
        });
        expect(await transaction.loadPublicationEffects("run-2")).toEqual({
          result: "complete",
        });
      },
    );
  }, 60_000);

  it("fails after a second Git conflict without discarding competing transitions", async () => {
    const { remote, checkout } = await temporaryGitRepository();
    const competingCheckout = join(await temporaryRoot(), "competing-checkout");
    await git(["clone", "--branch", "main", remote, competingCheckout], checkout);
    const targetStore = new GitReviewPersistenceStore({ gitDirectory: checkout });
    const competingStore = new GitReviewPersistenceStore({ gitDirectory: competingCheckout });
    let attempts = 0;

    await expect(
      targetStore.withTransaction(key, async (transaction) => {
        attempts += 1;
        await competingStore.withTransaction(key, async (competingTransaction) => {
          await competingTransaction.savePublicationEffects(`competing-${attempts}`, {
            result: "complete",
          });
        });
        await transaction.savePublicationEffects("target", { result: "complete" });
      }),
    ).rejects.toThrow("Unable to advance");

    expect(attempts).toBe(2);
    await competingStore.withTransaction(key, async (transaction) => {
      expect(await transaction.loadPublicationEffects("competing-1")).toEqual({
        result: "complete",
      });
      expect(await transaction.loadPublicationEffects("competing-2")).toEqual({
        result: "complete",
      });
      expect(await transaction.loadPublicationEffects("target")).toBeUndefined();
    });
  }, 60_000);

  it("refuses to recreate deleted Git state refs after prior state", async () => {
    const { remote, checkout } = await temporaryGitRepository();
    const store = new GitReviewPersistenceStore({ gitDirectory: checkout });
    await store.withTransaction(key, async (transaction) => transaction.saveLedger(ledger()));

    const stateRef = "refs/diffowl/state/repositories/example/review-target/pull-requests/42/state";
    const markerRef =
      "refs/diffowl/state/repositories/example/review-target/pull-requests/42/marker";
    await git(["push", "origin", `:${stateRef}`, `:${markerRef}`], checkout);

    await expect(
      store.withTransaction(key, async (transaction) => transaction.saveLedger(ledger("run-2"))),
    ).rejects.toThrow("deleted after prior state");

    const freshCheckout = join(await temporaryRoot(), "fresh-checkout");
    await git(["clone", remote, freshCheckout], checkout);
    await expect(
      new GitReviewPersistenceStore({ gitDirectory: freshCheckout }).withTransaction(
        key,
        async (transaction) => transaction.saveLedger(ledger("run-2")),
      ),
    ).rejects.toThrow("prior Diffowl state marker exists");
  }, 30_000);

  it("reports partial Git state ref deletion as configuration failure", async () => {
    const { checkout } = await temporaryGitRepository();
    const store = new GitReviewPersistenceStore({ gitDirectory: checkout });
    await store.withTransaction(key, async (transaction) => transaction.saveLedger(ledger()));

    const stateRef = "refs/diffowl/state/repositories/example/review-target/pull-requests/42/state";
    await git(["push", "origin", `:${stateRef}`], checkout);

    await expect(
      store.withTransaction(key, async (transaction) => transaction.saveLedger(ledger("run-2"))),
    ).rejects.toThrow("partial Diffowl state refs");
  }, 30_000);
});
// jscpd:ignore-end
