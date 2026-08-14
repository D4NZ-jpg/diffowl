/* oxlint-disable max-lines */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { canonicalJson, type JsonValue } from "./canonical-json.js";
import { parseFindingLedger, type FindingLedger } from "./finding-ledger.js";
import {
  type PullRequestPersistenceKey,
  type ReviewPersistenceStore,
  type ReviewPersistenceTransaction,
} from "./persistence.js";
import { parseReviewRunRecord, type ReviewRunRecord } from "./review-run-record.js";

interface PersistenceManifest {
  version: 1;
  ledger?: string | undefined;
  runs: Record<string, string>;
  publicationEffects: Record<string, string>;
  publicationState?: string | undefined;
}

interface StateDocument {
  manifest: PersistenceManifest;
  objects: Map<string, unknown>;
  tip: string | undefined;
}

interface GitStateMarker {
  version: 1;
  stateRef: string;
}

interface GitStateIndex {
  version: 1;
  initializedPullRequests: string[];
}

export interface GitReviewPersistenceOptions {
  remote?: string | undefined;
  refPrefix?: string | undefined;
  gitDirectory?: string | undefined;
}

const markerPath = ".diffowl-state-marker.json";

function configurationFailure(message: string): Error {
  return new Error(`GitHub Finding state is not configured correctly: ${message}`);
}

function execGit(args: string[], gitDirectory = process.cwd()): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: gitDirectory,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME ?? "Review OWL",
          GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL ?? "review-owl@users.noreply.github.com",
          GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME ?? "Review OWL",
          GIT_COMMITTER_EMAIL:
            process.env.GIT_COMMITTER_EMAIL ?? "review-owl@users.noreply.github.com",
        },
        maxBuffer: 50 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout.trimEnd());
          return;
        }
        const enriched = new Error(stderr.trim() || error.message);
        reject(enriched);
      },
    );
  });
}

function assertSafeSegment(value: string, noun: string): void {
  const valid = /^[A-Za-z0-9._-]+$/u.test(value) && value !== "." && value !== "..";
  if (!valid) throw configurationFailure(`${noun} contains an unsafe ref segment.`);
}

function assertSafeRunId(value: string): void {
  assertSafeSegment(value, "Run id");
}

function normalizedPersistenceKey(key: PullRequestPersistenceKey): string {
  const parts = key.repository.split("/");
  if (parts.length !== 2) throw configurationFailure("Repository key must use owner/name form.");
  for (const [index, part] of parts.entries())
    assertSafeSegment(part, `Repository segment ${index}`);
  if (!Number.isInteger(key.pullRequestNumber) || key.pullRequestNumber <= 0) {
    throw configurationFailure("Pull request number must be a positive integer.");
  }
  return `${parts[0]}/${parts[1]}#${key.pullRequestNumber}`;
}

function refsFor(
  key: PullRequestPersistenceKey,
  prefix: string,
): { state: string; marker: string; index: string; key: string } {
  const normalized = normalizedPersistenceKey(key);
  const [repository, pullRequestNumber] = normalized.split("#");
  const [owner, name] = repository!.split("/");
  const base = `${prefix}/repositories/${owner}/${name}/pull-requests/${pullRequestNumber}`;
  return {
    state: `${base}/state`,
    marker: `${base}/marker`,
    index: `${prefix}/marker`,
    key: normalized,
  };
}

// jscpd:ignore-start
// oxlint-disable-next-line complexity
function parseManifest(value: unknown): PersistenceManifest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw configurationFailure("The Finding ledger manifest has an invalid schema.");
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
    (record.ledger !== undefined && typeof record.ledger !== "string") ||
    (record.publicationState !== undefined && typeof record.publicationState !== "string")
  ) {
    throw configurationFailure("The Finding ledger manifest has an invalid schema.");
  }
  const runs = record.runs as Record<string, unknown>;
  const publicationEffects = (record.publicationEffects ?? {}) as Record<string, string>;
  for (const [runId, path] of [...Object.entries(runs), ...Object.entries(publicationEffects)]) {
    try {
      assertSafeRunId(runId);
    } catch {
      throw configurationFailure("The Finding ledger manifest has an invalid schema.");
    }
    if (typeof path !== "string" || !/^objects\/[A-Za-z0-9._-]+\.json$/u.test(path)) {
      throw configurationFailure("The Finding ledger manifest has an invalid schema.");
    }
  }
  if (
    [record.ledger, record.publicationState].some(
      (path) => typeof path === "string" && !/^objects\/[A-Za-z0-9._-]+\.json$/u.test(path),
    )
  ) {
    throw configurationFailure("The Finding ledger manifest has an invalid schema.");
  }
  return { ...(value as PersistenceManifest), publicationEffects };
}
// jscpd:ignore-end

function parseMarker(value: unknown, stateRef: string): GitStateMarker {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    (value as Record<string, unknown>).stateRef !== stateRef
  ) {
    throw configurationFailure(
      "The Diffowl state marker is invalid. Delete only the marker and state refs together when intentionally resetting state.",
    );
  }
  return value as GitStateMarker;
}

function parseIndex(value: unknown): GitStateIndex {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).version !== 1 ||
    !Array.isArray((value as Record<string, unknown>).initializedPullRequests) ||
    !(value as GitStateIndex).initializedPullRequests.every(
      (entry) =>
        typeof entry === "string" && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9][0-9]*$/u.test(entry),
    )
  ) {
    throw configurationFailure(
      "The Diffowl state marker index is invalid. Restore the base-repository Diffowl state refs before rerunning.",
    );
  }
  return value as GitStateIndex;
}

async function loadIndex(indexRef: string, gitDirectory: string): Promise<GitStateIndex> {
  const tip = await optionalRef(indexRef, gitDirectory);
  if (tip === undefined) return { version: 1, initializedPullRequests: [] };
  return parseIndex(await optionalJson(indexRef, "pull-requests.json", gitDirectory));
}

async function optionalRef(ref: string, gitDirectory: string): Promise<string | undefined> {
  try {
    return await execGit(["rev-parse", "--verify", `${ref}^{commit}`], gitDirectory);
  } catch {
    return undefined;
  }
}

async function optionalJson(
  ref: string,
  path: string,
  gitDirectory: string,
): Promise<unknown | undefined> {
  try {
    const contents = await execGit(["show", `${ref}:${path}`], gitDirectory);
    return JSON.parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("does not exist") || message.includes("exists on disk, but not in"))
      return undefined;
    if (message.includes("invalid object name") || message.includes("unknown revision"))
      return undefined;
    throw configurationFailure(`Stored Finding state is corrupt: ${message}`);
  }
}

async function loadState(
  refs: { state: string; marker: string; index: string; key: string },
  gitDirectory: string,
): Promise<StateDocument> {
  const [stateTip, markerTip] = await Promise.all([
    optionalRef(refs.state, gitDirectory),
    optionalRef(refs.marker, gitDirectory),
  ]);
  if (stateTip === undefined) {
    const index = await loadIndex(refs.index, gitDirectory);
    if (markerTip !== undefined || index.initializedPullRequests.includes(refs.key)) {
      throw configurationFailure(
        "The Finding state ref is missing even though a prior Diffowl state marker exists. Restore the ref instead of falling back to comments, checks, artifacts, caches, or variables.",
      );
    }
    return {
      manifest: { version: 1, runs: {}, publicationEffects: {} },
      objects: new Map(),
      tip: undefined,
    };
  }
  if (markerTip === undefined) {
    throw configurationFailure(
      "The Finding state ref exists without its Diffowl state marker; restore both refs from the base repository.",
    );
  }
  parseMarker(await optionalJson(refs.marker, markerPath, gitDirectory), refs.state);
  if (markerTip !== stateTip) {
    throw configurationFailure(
      "The Finding state ref appears to have been rewritten or partially updated. Restore the latest state ref and marker, then rerun.",
    );
  }
  parseMarker(await optionalJson(refs.state, markerPath, gitDirectory), refs.state);
  const manifest = parseManifest(await optionalJson(refs.state, "manifest.json", gitDirectory));
  const objects = new Map<string, unknown>();
  for (const path of new Set(
    [
      manifest.ledger,
      manifest.publicationState,
      ...Object.values(manifest.runs),
      ...Object.values(manifest.publicationEffects),
    ].filter(Boolean) as string[],
  )) {
    // oxlint-disable-next-line no-await-in-loop
    const value = await optionalJson(refs.state, path, gitDirectory);
    if (value === undefined)
      throw configurationFailure(`Persisted object ${path} is missing from Git state.`);
    objects.set(path, value);
  }
  return { manifest, objects, tip: stateTip };
}

// jscpd:ignore-start
class GitReviewPersistenceTransaction implements ReviewPersistenceTransaction {
  private stagedLedger: FindingLedger | undefined;
  private readonly stagedRuns = new Map<string, ReviewRunRecord>();
  private readonly stagedPublicationEffects = new Map<string, JsonValue>();
  private stagedPublicationState: JsonValue | undefined;

  constructor(private readonly state: StateDocument) {}

  async loadLedger(): Promise<FindingLedger | undefined> {
    if (this.stagedLedger !== undefined) return this.stagedLedger;
    if (this.state.manifest.ledger === undefined) return undefined;
    const value = this.state.objects.get(this.state.manifest.ledger);
    if (value === undefined)
      throw configurationFailure("Persisted ledger object is missing from Git state.");
    try {
      return parseFindingLedger(value);
    } catch (error) {
      throw configurationFailure(error instanceof Error ? error.message : String(error));
    }
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
    const path = this.state.manifest.runs[runId];
    if (path === undefined) return undefined;
    const value = this.state.objects.get(path);
    if (value === undefined)
      throw configurationFailure(`Persisted run record "${runId}" is missing from Git state.`);
    try {
      return parseReviewRunRecord(value);
    } catch (error) {
      throw configurationFailure(error instanceof Error ? error.message : String(error));
    }
  }

  async savePublicationEffects(runId: string, effects: JsonValue): Promise<void> {
    assertSafeRunId(runId);
    this.stagedPublicationEffects.set(runId, effects);
  }

  async loadPublicationEffects(runId: string): Promise<JsonValue | undefined> {
    assertSafeRunId(runId);
    const staged = this.stagedPublicationEffects.get(runId);
    if (staged !== undefined) return staged;
    const path = this.state.manifest.publicationEffects[runId];
    if (path === undefined) return undefined;
    const value = this.state.objects.get(path);
    if (value === undefined)
      throw configurationFailure(
        `Persisted publication effects "${runId}" are missing from Git state.`,
      );
    return value as JsonValue;
  }

  async savePublicationState(state: JsonValue): Promise<void> {
    this.stagedPublicationState = state;
  }

  async loadPublicationState(): Promise<JsonValue | undefined> {
    if (this.stagedPublicationState !== undefined) return this.stagedPublicationState;
    const path = this.state.manifest.publicationState;
    if (path === undefined) return undefined;
    const value = this.state.objects.get(path);
    if (value === undefined)
      throw configurationFailure("Persisted publication state is missing from Git state.");
    return value as JsonValue;
  }

  // jscpd:ignore-end

  materialize(): StateDocument | undefined {
    if (
      this.stagedLedger === undefined &&
      this.stagedRuns.size === 0 &&
      this.stagedPublicationEffects.size === 0 &&
      this.stagedPublicationState === undefined
    )
      return undefined;
    const generation = randomUUID();
    const next: StateDocument = {
      tip: this.state.tip,
      manifest: {
        ...this.state.manifest,
        runs: { ...this.state.manifest.runs },
        publicationEffects: { ...this.state.manifest.publicationEffects },
      },
      objects: new Map(this.state.objects),
    };
    if (this.stagedLedger !== undefined) {
      const path = `objects/ledger-${generation}.json`;
      next.objects.set(path, this.stagedLedger);
      next.manifest.ledger = path;
    }
    for (const [runId, record] of this.stagedRuns) {
      const path = `objects/run-${generation}-${runId}.json`;
      next.objects.set(path, record);
      next.manifest.runs[runId] = path;
    }
    for (const [runId, effects] of this.stagedPublicationEffects) {
      const path = `objects/publication-${generation}-${runId}.json`;
      next.objects.set(path, effects);
      next.manifest.publicationEffects[runId] = path;
    }
    if (this.stagedPublicationState !== undefined) {
      const path = `objects/publication-state-${generation}.json`;
      next.objects.set(path, this.stagedPublicationState);
      next.manifest.publicationState = path;
    }
    return next;
  }
}

async function commitState(
  refs: { state: string; marker: string },
  state: StateDocument,
  gitDirectory: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diffowl-git-state-"));
  try {
    await writeFile(
      join(directory, "manifest.json"),
      `${JSON.stringify(state.manifest, undefined, 2)}\n`,
    );
    await execGit(["-C", directory, "init", "-q"], process.cwd());
    await rm(join(directory, ".git"), { recursive: true, force: true });
    const rootEntries: string[] = [];
    const objectEntries: string[] = [];
    const manifestHash = await execGit(
      ["hash-object", "-w", join(directory, "manifest.json")],
      gitDirectory,
    );
    rootEntries.push(`100644 blob ${manifestHash}\tmanifest.json`);
    for (const [path, value] of state.objects) {
      const name = path.replace(/^objects\//u, "");
      const file = join(directory, name);
      // oxlint-disable-next-line no-await-in-loop
      await writeFile(file, `${JSON.stringify(value, undefined, 2)}\n`);
      // oxlint-disable-next-line no-await-in-loop
      const hash = await execGit(["hash-object", "-w", file], gitDirectory);
      objectEntries.push(`100644 blob ${hash}\t${name}`);
    }
    if (objectEntries.length > 0) {
      const objectsTree = await mktree(objectEntries, gitDirectory);
      rootEntries.push(`040000 tree ${objectsTree}\tobjects`);
    }
    const parentArgs = state.tip === undefined ? [] : ["-p", state.tip];
    const marker: GitStateMarker = { version: 1, stateRef: refs.state };
    const markerFile = join(directory, "marker.json");
    await writeFile(markerFile, `${JSON.stringify(marker, undefined, 2)}\n`);
    const markerHash = await execGit(["hash-object", "-w", markerFile], gitDirectory);
    const finalTree = await mktree(
      [...rootEntries, `100644 blob ${markerHash}\t${markerPath}`],
      gitDirectory,
    );
    return await execGit(
      ["commit-tree", finalTree, ...parentArgs, "-m", "Update Diffowl Finding state"],
      gitDirectory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function commitIndex(
  refs: { index: string; key: string },
  currentTip: string | undefined,
  index: GitStateIndex,
  gitDirectory: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "diffowl-git-state-index-"));
  try {
    const entries = new Set(index.initializedPullRequests);
    entries.add(refs.key);
    const next: GitStateIndex = {
      version: 1,
      // oxlint-disable-next-line unicorn/no-array-sort
      initializedPullRequests: [...entries].sort(),
    };
    const indexFile = join(directory, "pull-requests.json");
    await writeFile(indexFile, `${JSON.stringify(next, undefined, 2)}\n`);
    const indexHash = await execGit(["hash-object", "-w", indexFile], gitDirectory);
    const marker: GitStateMarker = { version: 1, stateRef: refs.index };
    const markerFile = join(directory, "marker.json");
    await writeFile(markerFile, `${JSON.stringify(marker, undefined, 2)}\n`);
    const markerHash = await execGit(["hash-object", "-w", markerFile], gitDirectory);
    const tree = await mktree(
      [`100644 blob ${indexHash}\tpull-requests.json`, `100644 blob ${markerHash}\t${markerPath}`],
      gitDirectory,
    );
    const parentArgs = currentTip === undefined ? [] : ["-p", currentTip];
    return await execGit(
      ["commit-tree", tree, ...parentArgs, "-m", "Update Diffowl state marker index"],
      gitDirectory,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function mktree(entries: string[], gitDirectory: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["mktree"],
      { cwd: gitDirectory, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error === null) resolve(stdout.trimEnd());
        else reject(new Error(stderr.trim() || error.message));
      },
    );
    // oxlint-disable-next-line unicorn/no-array-sort
    child.stdin?.end(`${[...entries].sort().join("\n")}\n`);
  });
}

async function remoteRef(
  remote: string,
  ref: string,
  gitDirectory: string,
): Promise<string | undefined> {
  try {
    const output = await execGit(["ls-remote", remote, ref], gitDirectory);
    const [sha] = output.split(/\s+/u);
    return sha === "" ? undefined : sha;
  } catch (error) {
    throw configurationFailure(
      `Unable to read Diffowl state refs from the base repository. Ensure the workflow checkout remote is the base repository and the GitHub token can read Contents. Git said: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function assertWritableStateRemote(
  remote: string,
  refPrefix: string,
  gitDirectory: string,
): Promise<void> {
  const probeRef = `${refPrefix}/access-check/${randomUUID()}`;
  let head: string;
  try {
    head = await execGit(["rev-parse", "--verify", "HEAD^{commit}"], gitDirectory);
  } catch (error) {
    throw configurationFailure(
      `Unable to identify the checked-out base repository revision before writing Finding state. Git said: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  try {
    await execGit(["push", "--dry-run", remote, `${head}:${probeRef}`], gitDirectory);
  } catch (error) {
    throw configurationFailure(
      `Unable to verify Contents: write permission for the base-repository Finding state ref. Configure the workflow with permissions: contents: write, and do not fall back to comments, checks, artifacts, caches, variables, or ephemeral state. Git said: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

// oxlint-disable-next-line complexity
async function fetchStateRefs(
  remote: string,
  refs: { state: string; marker: string; index: string },
  gitDirectory: string,
): Promise<void> {
  const [localState, localMarker, remoteState, remoteMarker, remoteIndex] = await Promise.all([
    optionalRef(refs.state, gitDirectory),
    optionalRef(refs.marker, gitDirectory),
    remoteRef(remote, refs.state, gitDirectory),
    remoteRef(remote, refs.marker, gitDirectory),
    remoteRef(remote, refs.index, gitDirectory),
  ]);
  const hadLocalState = localState !== undefined || localMarker !== undefined;
  const hasRemoteState = remoteState !== undefined || remoteMarker !== undefined;
  if (hadLocalState && !hasRemoteState) {
    throw configurationFailure(
      "The Finding state refs were deleted after prior state. Restore the base-repository Diffowl state refs instead of recreating them.",
    );
  }
  if (remoteIndex !== undefined) {
    await execGit(["fetch", remote, `${refs.index}:${refs.index}`], gitDirectory);
  }
  if (!hasRemoteState) return;
  if (remoteState === undefined || remoteMarker === undefined) {
    throw configurationFailure(
      "The base repository has partial Diffowl state refs. Restore both refs before rerunning.",
    );
  }
  try {
    await execGit(
      ["fetch", remote, `${refs.state}:${refs.state}`, `${refs.marker}:${refs.marker}`],
      gitDirectory,
    );
  } catch (error) {
    throw configurationFailure(
      `The Finding state ref appears to have been rewritten. Restore the latest state ref and marker before rerunning. Git said: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function pushRefs(
  remote: string,
  commit: string,
  indexCommit: string,
  refs: { state: string; marker: string; index: string },
  gitDirectory: string,
): Promise<void> {
  try {
    await execGit(
      [
        "push",
        "--atomic",
        remote,
        `${commit}:${refs.state}`,
        `${commit}:${refs.marker}`,
        `${indexCommit}:${refs.index}`,
      ],
      gitDirectory,
    );
    await Promise.all([
      execGit(["update-ref", refs.state, commit], gitDirectory),
      execGit(["update-ref", refs.marker, commit], gitDirectory),
      execGit(["update-ref", refs.index, indexCommit], gitDirectory),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw configurationFailure(
      `Unable to advance ${refs.state} without force. Ensure workflow permissions include Contents: write and no one deleted or rewrote Diffowl state. Git said: ${message}`,
    );
  }
}

export class GitReviewPersistenceStore implements ReviewPersistenceStore {
  private readonly remote: string;
  private readonly refPrefix: string;
  private readonly gitDirectory: string;

  constructor(options: GitReviewPersistenceOptions = {}) {
    this.remote = options.remote ?? "origin";
    this.refPrefix = options.refPrefix ?? "refs/diffowl/state";
    this.gitDirectory = options.gitDirectory ?? process.cwd();
  }

  async prepare(key: PullRequestPersistenceKey): Promise<void> {
    const refs = refsFor(key, this.refPrefix);
    await fetchStateRefs(this.remote, refs, this.gitDirectory);
    await loadState(refs, this.gitDirectory);
    await assertWritableStateRemote(this.remote, this.refPrefix, this.gitDirectory);
  }

  async withTransaction<T>(
    key: PullRequestPersistenceKey,
    operation: (transaction: ReviewPersistenceTransaction) => Promise<T>,
  ): Promise<T> {
    const refs = refsFor(key, this.refPrefix);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      // oxlint-disable-next-line no-await-in-loop
      await fetchStateRefs(this.remote, refs, this.gitDirectory);
      // oxlint-disable-next-line no-await-in-loop
      const state = await loadState(refs, this.gitDirectory);
      const transaction = new GitReviewPersistenceTransaction(state);
      // oxlint-disable-next-line no-await-in-loop
      const result = await operation(transaction);
      const next = transaction.materialize();
      if (next === undefined) return result;
      // oxlint-disable-next-line no-await-in-loop
      const index = await loadIndex(refs.index, this.gitDirectory);
      // oxlint-disable-next-line no-await-in-loop
      const indexTip = await optionalRef(refs.index, this.gitDirectory);
      // oxlint-disable-next-line no-await-in-loop
      const commit = await commitState(refs, next, this.gitDirectory);
      // oxlint-disable-next-line no-await-in-loop
      const indexCommit = await commitIndex(refs, indexTip, index, this.gitDirectory);
      try {
        // oxlint-disable-next-line no-await-in-loop
        await pushRefs(this.remote, commit, indexCommit, refs, this.gitDirectory);
        return result;
      } catch (error) {
        if (attempt === 1) throw error;
      }
    }
    throw configurationFailure(
      "Conflicting writers prevented advancing Git state after one retry.",
    );
  }
}
