/* oxlint-disable max-lines */
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

import { canonicalJson, type JsonValue } from "./canonical-json.js";
import { parseFindingLedger, type FindingLedger } from "./finding-ledger.js";
import { parseReviewRunRecord, type ReviewRunRecord } from "./review-run-record.js";

export interface PullRequestPersistenceKey {
  repository: string;
  pullRequestNumber: number;
}

export interface ReviewPersistenceStore {
  prepare?(key: PullRequestPersistenceKey): Promise<void>;
  withTransaction<T>(
    key: PullRequestPersistenceKey,
    operation: (transaction: ReviewPersistenceTransaction) => Promise<T>,
  ): Promise<T>;
}

export interface ReviewPersistenceTransaction {
  loadLedger(): Promise<FindingLedger | undefined>;
  saveLedger(ledger: FindingLedger): Promise<void>;
  saveRunRecord(record: ReviewRunRecord): Promise<void>;
  loadRunRecord(runId: string): Promise<ReviewRunRecord | undefined>;
  savePublicationEffects(runId: string, effects: JsonValue): Promise<void>;
  loadPublicationEffects(runId: string): Promise<JsonValue | undefined>;
}

interface PersistenceManifest {
  version: 1;
  ledger?: string | undefined;
  runs: Record<string, string>;
  publicationEffects: Record<string, string>;
}

function assertSafeSegment(value: string, noun: string): void {
  const valid = /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
  if (!valid) throw new Error(`${noun} contains an unsafe path segment.`);
}

function assertSafeRunId(value: string): void {
  assertSafeSegment(value, "Run id");
}

function safeResolve(root: string, ...parts: string[]): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, ...parts);
  if (target === resolvedRoot || target.startsWith(`${resolvedRoot}${sep}`)) return target;
  throw new Error("Persistence path escapes the configured state directory.");
}

function pullRequestDirectory(root: string, key: PullRequestPersistenceKey): string {
  const parts = key.repository.split("/");
  if (parts.length !== 2) throw new Error("Repository key must use owner/name form.");
  for (const [index, part] of parts.entries())
    assertSafeSegment(part, `Repository segment ${index}`);
  if (!Number.isInteger(key.pullRequestNumber) || key.pullRequestNumber <= 0) {
    throw new Error("Pull request number must be a positive integer.");
  }
  return safeResolve(
    root,
    "repositories",
    ...parts,
    "pull-requests",
    String(key.pullRequestNumber),
  );
}

async function atomicWrite(path: string, contents: string): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWrite(path, `${JSON.stringify(value, undefined, 2)}\n`);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

// oxlint-disable-next-line complexity
function parseManifest(value: unknown): PersistenceManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Persistence manifest is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.runs !== "object" ||
    record.runs === null ||
    Array.isArray(record.runs) ||
    (record.publicationEffects !== undefined &&
      (typeof record.publicationEffects !== "object" ||
        record.publicationEffects === null ||
        Array.isArray(record.publicationEffects))) ||
    (record.ledger !== undefined && typeof record.ledger !== "string")
  ) {
    throw new Error("Persistence manifest is invalid.");
  }
  const runs = record.runs as Record<string, unknown>;
  const publicationEffects = (record.publicationEffects ?? {}) as Record<string, string>;
  const validObjectMap = (entries: [string, unknown][]) =>
    entries.every(([runId, path]) => {
      try {
        assertSafeRunId(runId);
      } catch {
        return false;
      }
      return typeof path === "string" && /^objects\/[A-Za-z0-9._-]+\.json$/u.test(path);
    });
  if (!validObjectMap(Object.entries(runs)) || !validObjectMap(Object.entries(publicationEffects)))
    throw new Error("Persistence manifest is invalid.");
  if (
    typeof record.ledger === "string" &&
    !/^objects\/[A-Za-z0-9._-]+\.json$/u.test(record.ledger)
  ) {
    throw new Error("Persistence manifest is invalid.");
  }
  return { ...(value as PersistenceManifest), publicationEffects };
}

async function loadManifest(directory: string): Promise<PersistenceManifest> {
  const value = await readJson(join(directory, "manifest.json"));
  return value === undefined
    ? { version: 1, runs: {}, publicationEffects: {} }
    : parseManifest(value);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

interface LockOwner {
  token: string;
  pid: number;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

// oxlint-disable-next-line complexity
async function existingLockOwner(lockPath: string): Promise<LockOwner | null | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "token" in value &&
      typeof value.token === "string" &&
      "pid" in value &&
      typeof value.pid === "number" &&
      Number.isInteger(value.pid) &&
      value.pid > 0
    ) {
      return value as LockOwner;
    }
    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

async function removeAbandonedLock(lockPath: string): Promise<boolean> {
  const owner = await existingLockOwner(lockPath);
  if (owner === null || (owner !== undefined && processIsAlive(owner.pid))) return false;
  const quarantine = `${lockPath}.abandoned.${randomUUID()}`;
  try {
    await rename(lockPath, quarantine);
    await rm(quarantine, { recursive: true, force: true });
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return true;
    return false;
  }
}

async function acquireLock(lockPath: string, timeoutMs: number): Promise<LockOwner> {
  const owner: LockOwner = { token: randomUUID(), pid: process.pid };
  const candidatePath = `${lockPath}.candidate.${owner.token}`;
  await mkdir(candidatePath, { mode: 0o700 });
  await writeFile(join(candidatePath, "owner.json"), JSON.stringify(owner), {
    mode: 0o600,
    flag: "wx",
  });
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      try {
        // An initialized candidate directory makes lock acquisition atomic.
        // oxlint-disable-next-line no-await-in-loop
        await rename(candidatePath, lockPath);
        return owner;
      } catch (error) {
        const collision =
          error instanceof Error &&
          "code" in error &&
          (error.code === "EEXIST" || error.code === "ENOTEMPTY");
        if (!collision) throw error;
        // oxlint-disable-next-line no-await-in-loop
        if (!(await removeAbandonedLock(lockPath))) await wait(25);
      }
    }
    throw new Error("Timed out acquiring persistence lock.");
  } finally {
    await rm(candidatePath, { recursive: true, force: true });
  }
}

async function releaseLock(lockPath: string, owner: LockOwner): Promise<void> {
  const current = await existingLockOwner(lockPath);
  if (current === undefined) return;
  if (current === null || current.token !== owner.token || current.pid !== owner.pid) {
    throw new Error("Persistence lock ownership was lost.");
  }
  const releasedPath = `${lockPath}.released.${owner.token}`;
  await rename(lockPath, releasedPath);
  await rm(releasedPath, { recursive: true, force: true });
}

class FileSystemReviewPersistenceTransaction implements ReviewPersistenceTransaction {
  private stagedLedger: FindingLedger | undefined;
  private readonly stagedRuns = new Map<string, ReviewRunRecord>();
  private readonly stagedPublicationEffects = new Map<string, JsonValue>();

  constructor(
    private readonly directory: string,
    private readonly manifest: PersistenceManifest,
  ) {}

  async loadLedger(): Promise<FindingLedger | undefined> {
    if (this.stagedLedger !== undefined) return this.stagedLedger;
    if (this.manifest.ledger === undefined) return undefined;
    const value = await readJson(safeResolve(this.directory, this.manifest.ledger));
    if (value === undefined) throw new Error("Persisted ledger object is missing.");
    return parseFindingLedger(value);
  }

  async saveLedger(ledger: FindingLedger): Promise<void> {
    this.stagedLedger = parseFindingLedger(ledger);
  }

  async saveRunRecord(record: ReviewRunRecord): Promise<void> {
    assertSafeRunId(record.runId);
    const parsed = parseReviewRunRecord(record);
    const current = await this.loadRunRecord(record.runId);
    if (
      current !== undefined &&
      canonicalJson(current as unknown as JsonValue) !==
        canonicalJson(parsed as unknown as JsonValue)
    ) {
      throw new Error(`Run record "${record.runId}" is immutable.`);
    }
    this.stagedRuns.set(record.runId, parsed);
  }

  async loadRunRecord(runId: string): Promise<ReviewRunRecord | undefined> {
    assertSafeRunId(runId);
    const staged = this.stagedRuns.get(runId);
    if (staged !== undefined) return staged;
    const path = this.manifest.runs[runId];
    if (path === undefined) return undefined;
    const value = await readJson(safeResolve(this.directory, path));
    if (value === undefined) throw new Error(`Persisted run record "${runId}" is missing.`);
    return parseReviewRunRecord(value);
  }

  async savePublicationEffects(runId: string, effects: JsonValue): Promise<void> {
    assertSafeRunId(runId);
    this.stagedPublicationEffects.set(runId, effects);
  }

  async loadPublicationEffects(runId: string): Promise<JsonValue | undefined> {
    assertSafeRunId(runId);
    const staged = this.stagedPublicationEffects.get(runId);
    if (staged !== undefined) return staged;
    const path = this.manifest.publicationEffects[runId];
    if (path === undefined) return undefined;
    const value = await readJson(safeResolve(this.directory, path));
    if (value === undefined)
      throw new Error(`Persisted publication effects "${runId}" are missing.`);
    return value as JsonValue;
  }

  async commit(): Promise<void> {
    if (
      this.stagedLedger === undefined &&
      this.stagedRuns.size === 0 &&
      this.stagedPublicationEffects.size === 0
    )
      return;
    const generation = randomUUID();
    const next: PersistenceManifest = {
      ...this.manifest,
      runs: { ...this.manifest.runs },
      publicationEffects: { ...this.manifest.publicationEffects },
    };
    if (this.stagedLedger !== undefined) {
      const path = `objects/ledger-${generation}.json`;
      await atomicWriteJson(safeResolve(this.directory, path), this.stagedLedger);
      next.ledger = path;
    }
    for (const [runId, record] of this.stagedRuns) {
      const path = `objects/run-${generation}-${runId}.json`;
      // oxlint-disable-next-line no-await-in-loop
      await atomicWriteJson(safeResolve(this.directory, path), record);
      next.runs[runId] = path;
    }
    for (const [runId, effects] of this.stagedPublicationEffects) {
      const path = `objects/publication-${generation}-${runId}.json`;
      // oxlint-disable-next-line no-await-in-loop
      await atomicWriteJson(safeResolve(this.directory, path), effects);
      next.publicationEffects[runId] = path;
    }
    await atomicWriteJson(join(this.directory, "manifest.json"), next);
  }
}

async function preparePrivateRoot(rootDirectory: string): Promise<string> {
  const root = resolve(rootDirectory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error("Persistence root must be a real directory, not a symbolic link.");
  }
  await chmod(root, 0o700);
  return realpath(root);
}

export class FileSystemReviewPersistenceStore implements ReviewPersistenceStore {
  constructor(
    private readonly rootDirectory: string,
    private readonly lockTimeoutMs = 5_000,
  ) {}

  async withTransaction<T>(
    key: PullRequestPersistenceKey,
    operation: (transaction: ReviewPersistenceTransaction) => Promise<T>,
  ): Promise<T> {
    const root = await preparePrivateRoot(this.rootDirectory);
    const directory = pullRequestDirectory(root, key);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    const actualDirectory = await realpath(directory);
    if (actualDirectory !== directory)
      throw new Error("Persistence path must not traverse symbolic links.");
    const lockPath = `${directory}.lock`;
    const owner = await acquireLock(lockPath, this.lockTimeoutMs);
    try {
      const transaction = new FileSystemReviewPersistenceTransaction(
        directory,
        await loadManifest(directory),
      );
      const result = await operation(transaction);
      await transaction.commit();
      return result;
    } finally {
      await releaseLock(lockPath, owner);
    }
  }
}
