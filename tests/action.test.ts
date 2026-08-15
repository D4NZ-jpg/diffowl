/* oxlint-disable max-lines */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { publishActionOutcome } from "../src/action-publication.js";
import { createActionIo, runAction } from "../src/action.js";
import { findingIdentityMarker } from "../src/finding-discussion.js";
import { actionExitCodeForOutcome } from "../src/action-readiness.js";
import {
  IncompletePublicationError,
  PublicationRefusalError,
  type GitHubRequest,
  type PublicationAuthorization,
  publishReviewOutcome,
} from "../src/github-publication.js";
import {
  type CandidateDraft,
  FileSystemReviewPersistenceStore,
  GitReviewPersistenceStore,
  type RoleExecutionRequest,
} from "../src/review-engine.js";
import { persistedRunCount, temporaryStateDirectories } from "./persistence-fixtures.js";
import {
  completedReviewOutcome,
  emptyRoleResult,
  materialAssessment,
  projectPolicy,
  pullRequestEvent,
  reviewedPullRequest,
  roleArtifact,
  trustedSameRepoTrust,
  verifierResult,
} from "./review-fixtures.js";

const eventPath = fileURLToPath(
  new URL("./fixtures/github-pull-request-event.json", import.meta.url),
);

const representativePolicy = JSON.stringify(projectPolicy());
const stateDirectories = temporaryStateDirectories("diffowl-action-state-");

afterEach(stateDirectories.removeAll);

const representativeDiff = [
  "diff --git a/src/message.ts b/src/message.ts",
  "index ce01362..94954ab 100644",
  "--- a/src/message.ts",
  "+++ b/src/message.ts",
  "@@ -1 +1 @@",
  "-hello",
  "+hello owl",
  "",
].join("\n");

const passingValidationPolicy = JSON.stringify(
  projectPolicy({
    verification: {
      validationCommands: [
        { argv: [process.execPath, "-e", "process.stdout.write('passed')"], timeoutSeconds: 5 },
      ],
    },
  }),
);

type CapturedValidation = {
  validationAttempts?: Array<{ status: string; limitation?: string; stdout?: string }>;
};

async function validationAttemptsForRunner(
  runnerEnvironment: string | undefined,
): Promise<CapturedValidation["validationAttempts"]> {
  let verifierInput: CapturedValidation | undefined;
  await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      RUNNER_ENVIRONMENT: runnerEnvironment,
    },
    {
      readFile,
      readDiff: async () => representativeDiff,
      readPolicy: async () => passingValidationPolicy,
      setOutput: async () => undefined,
      executeRole: async (request) => {
        if (request.step.role === "verifier")
          verifierInput = request.roleInput as CapturedValidation;
        return emptyRoleResult(request);
      },
    },
  );
  return verifierInput?.validationAttempts;
}

function materialRoleResults(request: RoleExecutionRequest, candidateFindings: CandidateDraft[]) {
  if (request.step.role === "reviewer") {
    return {
      type: "completed" as const,
      output: { role: "reviewer" as const, candidateFindings, advisorySuggestions: [] },
      artifact: roleArtifact("reviewer"),
    };
  }
  if (request.step.role === "challenger") {
    return {
      type: "completed" as const,
      output: {
        role: "challenger" as const,
        assessments: candidateFindings.map((_finding, candidateIndex) => ({
          candidateIndex,
          verdict: "support" as const,
          reason: "supported",
        })),
      },
      artifact: roleArtifact("challenger"),
    };
  }
  return verifierResult(
    candidateFindings.map((_finding, candidateIndex) => ({
      ...materialAssessment(["scoped-diff"], "verified"),
      candidateIndex,
    })),
  );
}

function materialRoleResult(request: RoleExecutionRequest) {
  return materialRoleResults(request, [
    {
      summary: "Public greeting can be empty",
      location: { path: "src/message.ts", line: 1 },
      impact: "Callers receive an invalid response.",
      evidence: ["return greeting ?? ''"],
      fingerprintContext: {
        claimKind: "invalid-return",
        affectedArea: "greeting API",
        policyOrCapability: "runtime correctness",
        symbol: "greeting",
      },
    },
  ]);
}

function twoFindingRoleResult(request: RoleExecutionRequest) {
  return materialRoleResults(request, [
    {
      summary: "First material problem",
      location: { path: "src/message.ts", line: 1 },
      impact: "First impact.",
      evidence: ["first evidence"],
      fingerprintContext: { claimKind: "first-problem", symbol: "message" },
    },
    {
      summary: "Second material problem",
      location: { path: "src/message.ts", line: 1 },
      impact: "Second impact.",
      evidence: ["second evidence"],
      fingerprintContext: { claimKind: "second-problem", symbol: "message" },
    },
  ]);
}

function capturingActionIo(outputs: Map<string, string>) {
  return {
    readFile,
    readDiff: async () => representativeDiff,
    readPolicy: async () => representativePolicy,
    setOutput: async (name: string, value: string) => {
      outputs.set(name, value);
    },
    executeRole: async (request: RoleExecutionRequest) => emptyRoleResult(request),
  };
}

const confirmedReviewEffects = {
  headSha: reviewedPullRequest.headSha,
  reviewId: 41,
  inlineCommentCount: 1,
  unanchoredFindingCount: 0,
};

function publicationRunRecord(
  runId: string,
  recordedAt: string,
  headSha = reviewedPullRequest.headSha,
) {
  return {
    runId,
    recordedAt,
    revision: { pullRequest: { ...reviewedPullRequest, headSha } },
    trustClass: "trusted_same_repo_pull_request",
  };
}

function publicationOutcome(runId: string) {
  return {
    type: "clean",
    trust: trustedSameRepoTrust,
    pullRequest: reviewedPullRequest,
    materialFindings: [],
    run: { runId },
  } as never;
}

async function expectPersistedEffects(
  stateDirectory: string,
  runId: string | undefined,
  expected: Record<string, unknown>,
): Promise<void> {
  await new FileSystemReviewPersistenceStore(stateDirectory).withTransaction(
    { repository: reviewedPullRequest.repository, pullRequestNumber: reviewedPullRequest.number },
    async (transaction) => {
      expect(await transaction.loadPublicationEffects(runId ?? "missing")).toMatchObject(expected);
    },
  );
}

function expectCompleteJobSummary(summary: string): void {
  expect(summary).toContain("**Review readiness:** `ready for targeted human review`");
  expect(summary).toContain("[Pull-request review](https://github.example/review/41)");
  expect(summary).toContain("[Workflow logs](https://github.example/actions/runs/99)");
}

// The adapter contract is intentionally asserted in one integration-style example.
// oxlint-disable-next-line max-lines-per-function
it("supplies an environment credential profile to the Review engine", async () => {
  const outputs = new Map<string, string>();
  let execution: RoleExecutionRequest | undefined;

  const outcome = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
    },
    {
      readFile,
      readDiff: async (baseSha, headSha) => {
        expect(baseSha).toBe(reviewedPullRequest.baseSha);
        expect(headSha).toBe(reviewedPullRequest.headSha);
        return representativeDiff;
      },
      readPolicy: async (revision, path) => {
        expect(revision).toBe(reviewedPullRequest.baseSha);
        expect(path).toBe(".diffowl.json");
        return representativePolicy;
      },
      setOutput: async (name, value) => {
        outputs.set(name, value);
      },
      credentialProfiles: { default: { type: "env" } },
      executeRole: async (request) => {
        execution ??= request;
        return emptyRoleResult(request);
      },
    },
  );

  expect(execution).toMatchObject({
    step: { role: "reviewer", purpose: "generate_candidates" },
    credentials: { type: "env" },
  });
  expect(outcome).toEqual(
    completedReviewOutcome({
      trust: trustedSameRepoTrust,
      policy: projectPolicy(),
      policySource: {
        type: "trusted_base_branch",
        revision: reviewedPullRequest.baseSha,
        path: ".diffowl.json",
      },
      verification: {
        evidenceCatalog: [
          {
            id: "scoped-diff",
            type: "scoped_diff",
            path: "pull-request.diff",
            content: representativeDiff,
            truncated: false,
          },
        ],
        validationAttempts: [],
        limitations: [],
        coverageGaps: [],
      },
    }),
  );
  expect(JSON.parse(outputs.get("outcome") ?? "")).toEqual(outcome);
});

it("persists Action runs and publishes safe run outputs", async () => {
  const stateDirectory = await stateDirectories.create();
  const outputs = new Map<string, string>();

  const invoke = () =>
    runAction(
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        "INPUT_STATE-DIRECTORY": stateDirectory,
      },
      {
        readFile,
        readDiff: async () => representativeDiff,
        readPolicy: async () => representativePolicy,
        setOutput: async (name, value) => {
          outputs.set(name, value);
        },
        executeRole: async (request) => emptyRoleResult(request),
      },
    );
  await invoke();
  await invoke();

  expect(outputs.get("run-id")).toBeTruthy();
  expect(JSON.parse(outputs.get("run-metadata") ?? "")).toMatchObject({ recordVersion: 1 });
  expect(await persistedRunCount(stateDirectory)).toBe(2);
});

it("does not rescan historical Finding discussion comments during an ordinary Review", async () => {
  const stateDirectory = await stateDirectories.create();
  const event = JSON.stringify(pullRequestEvent({ actor: "author" }));
  const actionIo = {
    readFile: async () => event,
    readDiff: async () => representativeDiff,
    readPolicy: async () => representativePolicy,
    setOutput: async () => undefined,
    executeRole: async (request: RoleExecutionRequest) => emptyRoleResult(request),
    listFindingDiscussionComments: async () => {
      throw new Error("ordinary Review must not rescan historical comments");
    },
  };

  await expect(
    runAction(
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        INPUT_STATE_DIRECTORY: stateDirectory,
      },
      actionIo,
    ),
  ).resolves.toMatchObject({ type: "clean" });
});

// oxlint-disable-next-line max-lines-per-function
it("publishes one visible disposition per Finding transition in the same Action run", async () => {
  const stateDirectory = await stateDirectories.create();
  const baseIo = {
    readFile,
    readDiff: async () => representativeDiff,
    readPolicy: async () => representativePolicy,
    setOutput: async () => undefined,
  };
  const first = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      INPUT_STATE_DIRECTORY: stateDirectory,
    },
    { ...baseIo, executeRole: async (request) => twoFindingRoleResult(request) },
  );
  expect(first.type).toBe("findings");
  const fingerprints =
    first.type === "findings"
      ? first.materialFindings.map((finding) => finding.fingerprint.value)
      : [];
  const roots = fingerprints.map((fingerprint, index) => ({
    id: 10 + index,
    body: `${findingIdentityMarker(fingerprint)}\n### Review OWL material Finding`,
    user: { login: "github-actions[bot]", type: "Bot" },
  }));
  const requests: GitHubRequest[] = [];
  const transport = async (request: GitHubRequest): Promise<unknown> => {
    requests.push(request);
    if (request.method === "GET" && request.path.endsWith("/pulls/42")) {
      return { head: { sha: reviewedPullRequest.headSha } };
    }
    if (request.method === "GET" && request.path === "/user") {
      return { login: "github-actions[bot]" };
    }
    if (request.method === "GET" && request.path.includes("/pulls/42/comments")) return roots;
    if (request.path === "/graphql" && JSON.stringify(request.body).includes("reviewThreads")) {
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: roots.map((root, index) => ({
                  id: `thread-${index}`,
                  isResolved: false,
                  comments: { nodes: [{ databaseId: root.id }] },
                })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      };
    }
    if (request.path === "/graphql") {
      const threadId = String(
        (request.body as { variables: { threadId: string } }).variables.threadId,
      );
      return {
        data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } },
      };
    }
    return {};
  };

  await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      INPUT_STATE_DIRECTORY: stateDirectory,
    },
    {
      ...baseIo,
      executeRole: async (request) => emptyRoleResult(request),
      publishOutcome: (target, outcome, authorization) =>
        publishReviewOutcome(transport, target, outcome, authorization),
    },
  );

  const replies = requests.filter((request) => request.path.endsWith("/replies"));
  expect(requests.some((request) => request.path === "/user")).toBe(false);
  expect(replies).toHaveLength(2);
  expect(replies.map((request) => JSON.stringify(request.body))).toEqual([
    expect.stringContaining(`fingerprint=${fingerprints[0]} root=10`),
    expect.stringContaining(`fingerprint=${fingerprints[1]} root=11`),
  ]);
});

// oxlint-disable-next-line max-lines-per-function
it("publishes, reports, and persists adapter-owned receipts when a publisher is injected", async () => {
  const stateDirectory = await stateDirectories.create();
  const outputs = new Map<string, string>();
  const summaries: string[] = [];
  const calls: Array<{ repository: string; pullRequestNumber: number; headSha: string }> = [];
  const result = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      INPUT_STATE_DIRECTORY: stateDirectory,
    },
    {
      ...capturingActionIo(outputs),
      workflowRunUrl: "https://github.example/actions/runs/99",
      writeJobSummary: async (summary) => {
        summaries.push(summary);
      },
      publishOutcome: async (target, outcome, authorization) => {
        await authorization.claimAuthority?.();
        calls.push(target);
        expect(outcome.type).toBe("clean");
        expect(authorization).toMatchObject({
          sourceRunVerified: true,
          surfaces: ["pull_request_review"],
          claimAuthority: expect.any(Function),
          reserveEffect: expect.any(Function),
        });
        return {
          result: "complete",
          headSha: target.headSha,
          reviewUrl: "https://github.example/review/41",
          inlineCommentCount: 0,
          unanchoredFindingCount: 0,
        };
      },
    },
  );

  expect(calls).toEqual([
    {
      repository: reviewedPullRequest.repository,
      pullRequestNumber: reviewedPullRequest.number,
      headSha: reviewedPullRequest.headSha,
      changedLines: [{ path: "src/message.ts", line: 1 }],
    },
  ]);
  expect(JSON.parse(outputs.get("outcome") ?? "")).toEqual(result);
  const receipt = {
    result: "complete",
    headSha: reviewedPullRequest.headSha,
    reviewUrl: "https://github.example/review/41",
    inlineCommentCount: 0,
    unanchoredFindingCount: 0,
  };
  expect(JSON.parse(outputs.get("publication") ?? "")).toEqual(receipt);
  expect(summaries).toHaveLength(1);
  expectCompleteJobSummary(summaries[0] ?? "");
  await new FileSystemReviewPersistenceStore(stateDirectory).withTransaction(
    { repository: reviewedPullRequest.repository, pullRequestNumber: reviewedPullRequest.number },
    async (transaction) => {
      expect(await transaction.loadPublicationEffects(result.run?.runId ?? "missing")).toEqual(
        receipt,
      );
    },
  );
});

// The Action seam intentionally keeps generation, validation, persistence, and publication visible.
// oxlint-disable-next-line max-lines-per-function
it("carries an isolated exact-head Suggested patch through the Action publication seam", async () => {
  const stateDirectory = await stateDirectories.create();
  let publishedFinding: unknown;
  const patchPolicy = JSON.stringify(
    projectPolicy({
      verification: {
        validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 30 }],
        suggestedPatches: {
          sandboxImage: `node@sha256:${"a".repeat(64)}`,
          validationRules: [{ includePaths: ["src/message.ts"], commandIndex: 0 }],
        },
      },
    }),
  );

  const outcome = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      INPUT_STATE_DIRECTORY: stateDirectory,
    },
    {
      readFile,
      readDiff: async () => representativeDiff,
      readPolicy: async () => patchPolicy,
      setOutput: async () => undefined,
      executeRole: async (request) =>
        materialRoleResults(request, [
          {
            summary: "Public greeting is incorrect",
            location: { path: "src/message.ts", line: 1 },
            impact: "Callers receive the wrong value.",
            evidence: ["hello owl"],
            suggestedPatch: { startLine: 1, endLine: 1, replacement: "hello" },
          },
        ]),
      verificationAdapter: {
        readRepositoryFile: async () => ({ content: "hello owl\n", truncated: false }),
        executeValidation: async () => ({
          status: "passed",
          exitCode: 0,
          stdout: "passed",
          stderr: "",
          truncated: false,
        }),
        validateSuggestedPatch: async (request) => {
          expect(request).toMatchObject({
            headSha: reviewedPullRequest.headSha,
            expected: "hello owl",
            replacement: "hello",
            command: { commandIndex: 0, argv: ["npm", "test"] },
            security: { network: "denied", secrets: "denied" },
          });
          return {
            status: "passed",
            exitCode: 0,
            stdout: "passed",
            stderr: "",
            truncated: false,
          };
        },
      },
      publishOutcome: async (_target, published, authorization) => {
        await authorization.claimAuthority?.();
        publishedFinding =
          published.type === "findings" ? published.materialFindings[0] : undefined;
        return {
          result: "complete",
          headSha: reviewedPullRequest.headSha,
          inlineCommentCount: 1,
          unanchoredFindingCount: 0,
        };
      },
    },
  );

  expect(outcome.type).toBe("findings");
  expect(publishedFinding).toMatchObject({
    lifecycleState: "new",
    suggestedPatch: {
      path: "src/message.ts",
      reviewedHeadSha: reviewedPullRequest.headSha,
      replacement: "hello",
      validation: { commandIndex: 0, status: "passed" },
    },
  });
});

// oxlint-disable-next-line max-lines-per-function
it("refuses a stale run without overwriting the newest publication authority", async () => {
  const effects = new Map<string, unknown>();
  let publicationState: unknown;
  const records = new Map([
    ["run-new", publicationRunRecord("run-new", "2026-01-02T00:00:00.000Z")],
    ["run-old", publicationRunRecord("run-old", "2026-01-01T00:00:00.000Z")],
    ["run-alias", publicationRunRecord("different-run", "2026-01-03T00:00:00.000Z")],
    [
      "run-mismatch",
      publicationRunRecord(
        "run-mismatch",
        "2026-01-03T00:00:00.000Z",
        "3333333333333333333333333333333333333333",
      ),
    ],
  ]);
  const persistence = {
    withTransaction: async (_key: unknown, operation: (transaction: never) => Promise<unknown>) =>
      operation({
        loadRunRecord: async (runId: string) => records.get(runId),
        loadPublicationEffects: async (runId: string) => effects.get(runId),
        savePublicationEffects: async (runId: string, value: unknown) => {
          effects.set(runId, value);
        },
        loadPublicationState: async () => publicationState,
        savePublicationState: async (value: unknown) => {
          publicationState = value;
        },
      } as never),
  };
  const outputs = new Map<string, string>();
  let publications = 0;
  const io = {
    ...capturingActionIo(outputs),
    publishOutcome: async (
      _target: unknown,
      _outcome: unknown,
      authorization: PublicationAuthorization,
    ) => {
      await authorization.claimAuthority?.();
      publications += 1;
      return {
        result: "complete" as const,
        headSha: reviewedPullRequest.headSha,
        inlineCommentCount: 0,
        unanchoredFindingCount: 0,
      };
    },
  };
  const pullRequest = {
    number: reviewedPullRequest.number,
    head: { sha: reviewedPullRequest.headSha },
  } as never;

  await publishActionOutcome(
    io,
    reviewedPullRequest.repository,
    pullRequest,
    publicationOutcome("run-new"),
    [],
    persistence as never,
  );
  await expect(
    publishActionOutcome(
      io,
      reviewedPullRequest.repository,
      pullRequest,
      publicationOutcome("run-old"),
      [],
      persistence as never,
    ),
  ).rejects.toThrow("newer verified run");
  await expect(
    publishActionOutcome(
      io,
      reviewedPullRequest.repository,
      pullRequest,
      publicationOutcome("run-alias"),
      [],
      persistence as never,
    ),
  ).rejects.toThrow("does not match publication");
  await expect(
    publishActionOutcome(
      io,
      reviewedPullRequest.repository,
      pullRequest,
      publicationOutcome("run-mismatch"),
      [],
      persistence as never,
    ),
  ).rejects.toThrow("does not match publication");

  expect(publications).toBe(1);
  expect(publicationState).toMatchObject({
    authority: { runId: "run-new", result: "complete" },
  });
  expect(effects.get("run-old")).toMatchObject({ result: "refused" });
});

it("maps non-clean Review outcomes to a failing workflow check", () => {
  const clean = { type: "clean", trust: trustedSameRepoTrust };
  expect(actionExitCodeForOutcome(clean as never)).toBe(0);
  expect(
    actionExitCodeForOutcome({
      type: "provider_failure",
      reason: "provider failed",
      trust: trustedSameRepoTrust,
      pullRequest: reviewedPullRequest,
      policy: {
        source: { type: "trusted_base_branch", revision: "base", path: ".diffowl.json" },
        effective: projectPolicy(),
      },
      executionArtifacts: [],
    } as never),
  ).toBe(1);
});

it("removes GITHUB_TOKEN from the engine environment while retaining a publisher", () => {
  const env = { GITHUB_TOKEN: "publisher-secret", GITHUB_OUTPUT: "output" };
  const io = createActionIo(env);
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(io.publishOutcome).toBeTypeOf("function");
  expect(io.gitPersistence).toBeInstanceOf(GitReviewPersistenceStore);
});

async function publicationFailureOutputs(error: Error) {
  const outputs = new Map<string, string>();
  const stateDirectory = await stateDirectories.create();
  await expect(
    runAction(
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        INPUT_STATE_DIRECTORY: stateDirectory,
      },
      {
        ...capturingActionIo(outputs),
        publishOutcome: async (_target, _outcome, authorization) => {
          await authorization.claimAuthority?.();
          throw error;
        },
      },
    ),
  ).rejects.toThrow("Refusing to publish");
  expect(JSON.parse(outputs.get("outcome") ?? "{}")).toMatchObject({ type: "clean" });
  return JSON.parse(outputs.get("publication") ?? "{}");
}

it("reports publication denial as a separate incomplete publication", async () => {
  await expect(
    publicationFailureOutputs(
      new Error("Refusing to publish an invalid, oversized, or stale Review outcome."),
    ),
  ).resolves.toEqual({
    result: "incomplete",
    reason: "Refusing to publish an invalid, oversized, or stale Review outcome.",
  });
});

it("records publication as refused when publication validation rejects", async () => {
  await expect(publicationFailureOutputs(new PublicationRefusalError())).resolves.toEqual({
    result: "refused",
    reason: "Refusing to publish an invalid, oversized, or stale Review outcome.",
  });
});

it("preserves confirmed effects when job-summary publication fails", async () => {
  const stateDirectory = await stateDirectories.create();
  const outputs = new Map<string, string>();
  const confirmedEffects = { ...confirmedReviewEffects, result: "complete" as const };

  await expect(
    runAction(
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        INPUT_STATE_DIRECTORY: stateDirectory,
      },
      {
        ...capturingActionIo(outputs),
        executeRole: async (request) => materialRoleResult(request),
        publishOutcome: async (_target, _outcome, authorization) => {
          await authorization.claimAuthority?.();
          return confirmedEffects;
        },
        writeJobSummary: async () => {
          throw new Error("job summary unavailable");
        },
      },
    ),
  ).rejects.toThrow("job summary unavailable");

  expect(JSON.parse(outputs.get("publication") ?? "{}")).toMatchObject({
    ...confirmedEffects,
    result: "incomplete",
    reason: "job summary unavailable",
  });
  const outcome = JSON.parse(outputs.get("outcome") ?? "{}") as { run?: { runId?: string } };
  await expectPersistedEffects(stateDirectory, outcome.run?.runId, {
    reviewId: 41,
    result: "incomplete",
  });
});

it("reports incomplete publication when confirmed-effect persistence fails", async () => {
  const outputs = new Map<string, string>();
  const summaries: string[] = [];
  const outcome = {
    type: "clean",
    trust: trustedSameRepoTrust,
    pullRequest: reviewedPullRequest,
    materialFindings: [],
    run: { runId: "run-1" },
  };
  const io = {
    ...capturingActionIo(outputs),
    writeJobSummary: async (summary: string) => {
      summaries.push(summary);
    },
    publishOutcome: async (
      _target: unknown,
      _outcome: unknown,
      authorization: PublicationAuthorization,
    ) => {
      await authorization.claimAuthority?.();
      return { ...confirmedReviewEffects, result: "complete" as const };
    },
  };

  let persistenceTransactions = 0;
  await expect(
    publishActionOutcome(
      io,
      reviewedPullRequest.repository,
      {
        number: reviewedPullRequest.number,
        head: { sha: reviewedPullRequest.headSha },
      } as never,
      outcome as never,
      [],
      {
        withTransaction: async (_key, operation) => {
          persistenceTransactions += 1;
          if (persistenceTransactions > 1) throw new Error("Finding ledger unavailable");
          return operation({
            loadRunRecord: async () => publicationRunRecord("run-1", "2026-01-01T00:00:00.000Z"),
            loadPublicationEffects: async () => undefined,
            savePublicationEffects: async () => undefined,
            loadPublicationState: async () => undefined,
            savePublicationState: async () => undefined,
          } as never);
        },
      },
    ),
  ).rejects.toThrow("Finding ledger unavailable");

  expect(JSON.parse(outputs.get("publication") ?? "{}")).toMatchObject({
    result: "incomplete",
    reviewId: 41,
    reason: "Finding ledger unavailable",
  });
  expect(summaries.at(-1)).toContain("**Publication result:** `incomplete`");
});

it("records confirmed effects when required publication is incomplete", async () => {
  const stateDirectory = await stateDirectories.create();
  const outputs = new Map<string, string>();
  const receipt = {
    ...confirmedReviewEffects,
    result: "incomplete" as const,
    reason: "The pull-request head changed after review creation.",
  };

  // jscpd:ignore-start
  await expect(
    runAction(
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        INPUT_STATE_DIRECTORY: stateDirectory,
      },
      {
        ...capturingActionIo(outputs),
        executeRole: async (request) => materialRoleResult(request),
        publishOutcome: async (_target, _outcome, authorization) => {
          await authorization.claimAuthority?.();
          throw new IncompletePublicationError(receipt.reason, receipt);
        },
      },
    ),
  ).rejects.toThrow(receipt.reason);
  // jscpd:ignore-end

  expect(JSON.parse(outputs.get("publication") ?? "{}")).toEqual(receipt);
  const outcome = JSON.parse(outputs.get("outcome") ?? "{}") as { run?: { runId?: string } };
  await expectPersistedEffects(stateDirectory, outcome.run?.runId, receipt);
});

it("records publication as not attempted when no publisher is configured", async () => {
  const outputs = new Map<string, string>();
  await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
    capturingActionIo(outputs),
  );
  expect(outputs.has("outcome")).toBe(true);
  expect(JSON.parse(outputs.get("publication") ?? "{}")).toEqual({ result: "not_attempted" });
});

it("records validation as unavailable by default on unknown and self-hosted runners", async () => {
  const attempts = await Promise.all([undefined, "self-hosted"].map(validationAttemptsForRunner));

  for (const attempt of attempts) {
    expect(attempt).toEqual([
      expect.objectContaining({
        status: "error",
        limitation: "No validation execution adapter was configured.",
      }),
    ]);
  }
});

it("executes configured validation by default on a GitHub-hosted runner", async () => {
  const attempts = await validationAttemptsForRunner("github-hosted");

  expect(attempts).toEqual([expect.objectContaining({ status: "passed", stdout: "passed" })]);
});

it("denies risky capabilities and publishing for a fork pull request", async () => {
  const event = pullRequestEvent({
    headRepository: "contributor/review-target",
    actor: "contributor",
  });
  let published = false;

  const outcome = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: "event.json",
      GITHUB_TOKEN: "must-not-be-used",
    },
    {
      readFile: async () => JSON.stringify(event),
      readDiff: async () => representativeDiff,
      readPolicy: async () => representativePolicy,
      setOutput: async () => undefined,
      publishOutcome: async () => {
        published = true;
        throw new Error("untrusted outcome must not publish");
      },
    },
  );

  expect(published).toBe(false);
  expect(outcome).toMatchObject({
    type: "partial_coverage",
    reason: "Trust restrictions permit static review only; validation commands are denied.",
    trust: {
      class: "untrusted_pull_request",
      source: "fork",
      capabilities: {
        validationCommands: "denied",
        secrets: "denied",
        writeTokens: "denied",
        privilegedTools: "denied",
        publishing: "denied",
      },
    },
  });
});

it("treats Dependabot as untrusted and does not publish", async () => {
  const event = pullRequestEvent({ actor: "dependabot[bot]" });
  let published = false;
  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "event.json" },
    {
      ...capturingActionIo(new Map()),
      readFile: async () => JSON.stringify(event),
      publishOutcome: async () => {
        published = true;
        throw new Error("Dependabot outcome must not publish");
      },
    },
  );

  expect(published).toBe(false);
  expect(outcome).toMatchObject({
    type: "partial_coverage",
    reason: "Trust restrictions permit static review only; validation commands are denied.",
    trust: { class: "untrusted_pull_request", source: "dependabot" },
  });
});

it("skips pull_request_target before reading the event payload", async () => {
  let eventRead = false;

  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: "event.json" },
    {
      readFile: async () => {
        eventRead = true;
        return "{}";
      },
      readDiff: async () => representativeDiff,
      readPolicy: async () => representativePolicy,
      setOutput: async () => undefined,
    },
  );

  expect(eventRead).toBe(false);
  expect(outcome).toMatchObject({
    type: "policy_skip",
    trust: { class: "unsafe_or_unsupported" },
  });
});

it("reports unsupported pull-request shapes before reading repository content", async () => {
  let repositoryRead = false;
  const outputs = new Map<string, string>();

  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "event.json" },
    {
      readFile: async () => JSON.stringify({ action: "push" }),
      readDiff: async () => {
        repositoryRead = true;
        return representativeDiff;
      },
      readPolicy: async () => {
        repositoryRead = true;
        return representativePolicy;
      },
      setOutput: async (name, value) => {
        outputs.set(name, value);
      },
    },
  );

  expect(repositoryRead).toBe(false);
  expect(outcome).toEqual({
    type: "unsupported_change",
    reason: "The GitHub event is not a supported pull-request event.",
    trust: {
      class: "unsafe_or_unsupported",
      reason: "The GitHub event is not a supported pull-request event.",
      capabilities: {
        validationCommands: "denied",
        secrets: "denied",
        writeTokens: "denied",
        privilegedTools: "denied",
        publishing: "denied",
      },
    },
  });
  expect(JSON.parse(outputs.get("outcome") ?? "{}")).toEqual(outcome);
  expect(JSON.parse(outputs.get("publication") ?? "{}")).toEqual({ result: "not_attempted" });
});

it("skips an unsafe pull-request identity before reading repository content", async () => {
  let repositoryRead = false;
  const event = {
    repository: { full_name: "example/review-target" },
    pull_request: {
      number: 42,
      base: {
        sha: reviewedPullRequest.baseSha,
        repo: { full_name: "attacker/review-target" },
      },
      head: {
        sha: reviewedPullRequest.headSha,
        repo: { full_name: "attacker/review-target" },
      },
    },
  };

  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "event.json" },
    {
      readFile: async () => JSON.stringify(event),
      readDiff: async () => {
        repositoryRead = true;
        return representativeDiff;
      },
      readPolicy: async () => {
        repositoryRead = true;
        return representativePolicy;
      },
      setOutput: async () => undefined,
    },
  );

  expect(repositoryRead).toBe(false);
  expect(outcome).toMatchObject({
    type: "policy_skip",
    trust: { class: "unsafe_or_unsupported" },
  });
});
