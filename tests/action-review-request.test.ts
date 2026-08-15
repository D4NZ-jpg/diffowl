/* oxlint-disable max-lines, max-lines-per-function */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { type ActionIo, runAction } from "../src/action.js";
import { publishFindingDiscussionUpdate } from "../src/github-finding-command.js";
import type { GitHubRequest } from "../src/github-publication.js";
import { FileSystemReviewPersistenceStore } from "../src/persistence.js";
import { temporaryStateDirectories } from "./persistence-fixtures.js";
import { emptyRoleResult, projectPolicy } from "./review-fixtures.js";

const temporaryDirectories = temporaryStateDirectories("diffowl-action-request-");

afterEach(temporaryDirectories.removeAll);

function verifiedDispatchIo(overrides: Partial<ActionIo> = {}): ActionIo {
  return {
    readFile: async () => "{}",
    readPullRequest: async () => ({
      number: 42,
      author: "octocat",
      baseSha: "base-sha",
      headSha: "head-sha",
      baseRepository: "example/repository",
      headRepository: "example/repository",
    }),
    readCheckoutHead: async () => "head-sha",
    readDiff: async () => "",
    readPolicy: async () => JSON.stringify(projectPolicy()),
    setOutput: async () => {},
    ...overrides,
  };
}

async function seedFindingCommand(
  persistence: FileSystemReviewPersistenceStore,
  fingerprint: string,
  eventId: string,
  command: "recheck" | "reassess" | "rebut" = "recheck",
  reviewedHeadSha = "head-sha",
): Promise<void> {
  await persistence.withTransaction(
    { repository: "example/repository", pullRequestNumber: 42 },
    async (transaction) => {
      await transaction.saveLedger({
        version: 1,
        entries: [
          {
            fingerprint,
            summary: "Finding",
            locationPath: "src/example.ts",
            locationLine: 7,
            reviewedHeadSha,
            lifecycleState: "persisting",
            firstSeenRunId: "run-1",
            lastChangedRunId: "run-1",
            lastSeenRunId: "run-1",
          },
        ],
      });
      await transaction.saveReviewRequests({
        version: 1,
        events: {
          [eventId]: {
            eventId,
            actor: "octocat",
            command,
            observedAt: "2026-08-15T00:00:00.000Z",
            headSha: "head-sha",
            workType: reviewedHeadSha === "head-sha" ? "finding_discussion" : "full_review",
            findingFingerprint: fingerprint,
            ...(command === "reassess" ? { findingContext: "Approved product context." } : {}),
            rootCommentId: "10",
            reviewedHeadSha,
            decision: "dispatch",
            requestId: eventId,
            eyesAt: "2026-08-15T00:00:00.000Z",
            dispatchedAt: "2026-08-15T00:00:00.000Z",
          },
        },
        requests: {
          [eventId]: {
            requestId: eventId,
            headSha: "head-sha",
            status: "queued",
            requestedAt: "2026-08-15T00:00:00.000Z",
          },
        },
      });
    },
  );
}

function findingDispatchEnvironment(
  stateDirectory: string,
  eventId: string,
  runId: string,
): NodeJS.ProcessEnv {
  return {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    INPUT_REPOSITORY: "example/repository",
    "INPUT_PULL-REQUEST-NUMBER": "42",
    "INPUT_BASE-SHA": "base-sha",
    "INPUT_HEAD-SHA": "head-sha",
    "INPUT_REVIEW-REQUEST-EVENT-ID": eventId,
    "INPUT_SELF-HOSTED-STATE-DIRECTORY": stateDirectory,
    GITHUB_RUN_ID: runId,
  };
}

it("refuses a workflow dispatch without a durable accepted Review request", async () => {
  const directory = await temporaryDirectories.create();
  const eventPath = join(directory, "event.json");
  await writeFile(eventPath, "{}", "utf8");
  let readPullRequest = false;
  let readRepository = false;
  const outputs = new Map<string, string>();
  const io: ActionIo = {
    readFile: async () => "{}",
    readPullRequest: async () => {
      readPullRequest = true;
      return {
        number: 42,
        author: "octocat",
        baseSha: "base-sha",
        headSha: "head-sha",
        baseRepository: "example/repository",
        headRepository: "example/repository",
      };
    },
    readCheckoutHead: async () => "head-sha",
    readDiff: async () => {
      readRepository = true;
      return "";
    },
    readPolicy: async () => {
      readRepository = true;
      return undefined;
    },
    setOutput: async (name, value) => {
      outputs.set(name, value);
    },
  };

  const outcome = await runAction(
    {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      GITHUB_EVENT_PATH: eventPath,
      INPUT_REPOSITORY: "example/repository",
      "INPUT_PULL-REQUEST-NUMBER": "42",
      "INPUT_BASE-SHA": "base-sha",
      "INPUT_HEAD-SHA": "head-sha",
      "INPUT_REVIEW-REQUEST-EVENT-ID": "9001",
      "INPUT_SELF-HOSTED-STATE-DIRECTORY": join(directory, "state"),
      GITHUB_RUN_ID: "1234",
    },
    io,
  );

  expect(outcome).toMatchObject({
    type: "policy_skip",
    reason: "The workflow dispatch is not backed by an accepted Review request.",
  });
  expect(readPullRequest).toBe(true);
  expect(readRepository).toBe(false);
  expect(JSON.parse(outputs.get("outcome") ?? "{}")).toEqual(outcome);
});

it("runs current-head PR-wide Finding commands as bounded timeline discussion work", async () => {
  const directory = await temporaryDirectories.create();
  const stateDirectory = join(directory, "state");
  const persistence = new FileSystemReviewPersistenceStore(stateDirectory);
  const fingerprint = `sha256:${"a".repeat(64)}`;
  await persistence.withTransaction(
    { repository: "example/repository", pullRequestNumber: 42 },
    async (transaction) => {
      await transaction.saveLedger({
        version: 1,
        entries: [
          {
            fingerprint,
            summary: "Finding",
            locationPath: "src/example.ts",
            reviewedHeadSha: "head-sha",
            lifecycleState: "persisting",
            firstSeenRunId: "run-1",
            lastChangedRunId: "run-1",
            lastSeenRunId: "run-1",
          },
        ],
      });
      await transaction.saveReviewRequests({
        version: 1,
        events: {
          "finding-1": {
            eventId: "finding-1",
            actor: "octocat",
            command: "recheck",
            observedAt: "2026-08-15T00:00:00.000Z",
            headSha: "head-sha",
            workType: "finding_discussion",
            findingFingerprint: fingerprint,
            rootCommentId: "finding-1",
            reviewedHeadSha: "head-sha",
            decision: "dispatch",
            requestId: "finding-1",
            eyesAt: "2026-08-15T00:00:00.000Z",
            dispatchedAt: "2026-08-15T00:00:00.000Z",
          },
        },
        requests: {
          "finding-1": {
            requestId: "finding-1",
            headSha: "head-sha",
            status: "queued",
            requestedAt: "2026-08-15T00:00:00.000Z",
          },
        },
      });
    },
  );
  const published: unknown[] = [];
  const outputs = new Map<string, string>();
  const summaries: string[] = [];
  let validations = 0;
  const outcome = await runAction(
    {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      INPUT_REPOSITORY: "example/repository",
      "INPUT_PULL-REQUEST-NUMBER": "42",
      "INPUT_BASE-SHA": "base-sha",
      "INPUT_HEAD-SHA": "head-sha",
      "INPUT_REVIEW-REQUEST-EVENT-ID": "finding-1",
      "INPUT_SELF-HOSTED-STATE-DIRECTORY": stateDirectory,
      GITHUB_RUN_ID: "1236",
    },
    verifiedDispatchIo({
      readDiff: async () => {
        throw new Error("bounded Finding work must not read the full diff");
      },
      readPolicy: async () =>
        JSON.stringify({
          ...projectPolicy(),
          verification: { validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 30 }] },
        }),
      setOutput: async (name, value) => {
        outputs.set(name, value);
      },
      writeJobSummary: async (summary) => {
        summaries.push(summary);
      },
      publishFindingDiscussion: async (update) => {
        published.push(update);
        return {
          result: "complete",
          headSha: "head-sha",
          rootCommentId: "finding-1",
          replyCreated: true,
          threadResolved: false,
          inlineCommentCount: 0,
          unanchoredFindingCount: 0,
        };
      },
      verificationAdapter: {
        readRepositoryFile: async () => undefined,
        executeValidation: async () => {
          validations += 1;
          return { status: "passed", stdout: "ok", stderr: "", truncated: false };
        },
      },
    }),
  );

  expect(outcome).toMatchObject({
    type: "partial_coverage",
    reason: "Bounded Finding discussion work; no full Review was performed.",
  });
  expect(validations).toBe(1);
  expect(published).toEqual([
    expect.objectContaining({
      rootCommentId: "finding-1",
      rootSurface: "issue_comment",
      lifecycleState: "persisting",
      body: expect.stringContaining("rechecked"),
    }),
  ]);
  expect(JSON.parse(outputs.get("publication") ?? "{}")).toMatchObject({
    result: "complete",
    rootCommentId: "finding-1",
    replyCreated: true,
  });
  expect(summaries.join("\n")).toContain("**Publication result:** `complete`");
  await persistence.withTransaction(
    { repository: "example/repository", pullRequestNumber: 42 },
    async (transaction) => {
      expect(await transaction.loadPublicationEffects("command-finding-1")).toMatchObject({
        result: "complete",
        rootCommentId: "finding-1",
      });
    },
  );
});

it("carries newer-head reassessment context into the full Review verifier", async () => {
  const directory = await temporaryDirectories.create();
  const stateDirectory = join(directory, "state");
  const persistence = new FileSystemReviewPersistenceStore(stateDirectory);
  const fingerprint = `sha256:${"9".repeat(64)}`;
  await seedFindingCommand(
    persistence,
    fingerprint,
    "finding-new-head",
    "reassess",
    "reviewed-head",
  );
  let verifierInput: unknown;

  await runAction(
    findingDispatchEnvironment(stateDirectory, "finding-new-head", "1242"),
    verifiedDispatchIo({
      readDiff: async () =>
        [
          "diff --git a/src/example.ts b/src/example.ts",
          "--- a/src/example.ts",
          "+++ b/src/example.ts",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      executeRole: async (request) => {
        if (request.step.role === "verifier") verifierInput = request.roleInput;
        return emptyRoleResult(request);
      },
    }),
  );

  expect(verifierInput).toMatchObject({
    findingReassessmentContexts: [{ fingerprint, context: "Approved product context." }],
  });
});

// jscpd:ignore-start
it("does not create a moved-code replacement without a validated changed-line anchor", async () => {
  const directory = await temporaryDirectories.create();
  const stateDirectory = join(directory, "state");
  const persistence = new FileSystemReviewPersistenceStore(stateDirectory);
  const fingerprint = `sha256:${"d".repeat(64)}`;
  await seedFindingCommand(persistence, fingerprint, "finding-moved");
  const requests: GitHubRequest[] = [];
  const transport = async (request: GitHubRequest): Promise<unknown> => {
    requests.push(request);
    if (request.method === "GET" && request.path.endsWith("/pulls/42")) {
      return { head: { sha: "head-sha" } };
    }
    if (request.method === "GET") return [];
    if (request.path.endsWith("/10/replies")) {
      throw new Error("GitHub API POST reply failed (422).");
    }
    return {};
  };
  const outputs = new Map<string, string>();

  await expect(
    runAction(
      findingDispatchEnvironment(stateDirectory, "finding-moved", "1239"),
      verifiedDispatchIo({
        setOutput: async (name, value) => {
          outputs.set(name, value);
        },
        publishFindingDiscussion: (update) => publishFindingDiscussionUpdate(transport, update),
      }),
    ),
  ).rejects.toThrow("GitHub API POST reply failed (422)");

  expect(
    requests.some(
      (request) => request.method === "POST" && request.path.endsWith("/pulls/42/comments"),
    ),
  ).toBe(false);
  expect(JSON.parse(outputs.get("publication") ?? "{}")).toMatchObject({ result: "incomplete" });
});

it("finds durable Finding roots beyond the first GraphQL review-thread page", async () => {
  let threadQueries = 0;
  const transport = async (request: GitHubRequest): Promise<unknown> => {
    if (request.method === "GET" && request.path.endsWith("/pulls/42")) {
      return { head: { sha: "head-sha" } };
    }
    if (request.method === "GET") return [];
    if (request.path.endsWith("/10/replies")) return {};
    if (request.path === "/graphql") {
      threadQueries += 1;
      const cursor = (request.body as { variables?: { cursor?: string } }).variables?.cursor;
      if (cursor === undefined || cursor === null) {
        return {
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: Array.from({ length: 100 }, (_, index) => ({
                    id: `thread-${index}`,
                    isResolved: false,
                    comments: { nodes: [{ databaseId: index + 100 }] },
                  })),
                  pageInfo: { hasNextPage: true, endCursor: "page-1" },
                },
              },
            },
          },
        };
      }
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-10",
                    isResolved: false,
                    comments: { nodes: [{ databaseId: 10 }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      };
    }
    return {};
  };

  await expect(
    publishFindingDiscussionUpdate(transport, {
      repository: "example/repository",
      pullRequestNumber: 42,
      headSha: "head-sha",
      rootCommentId: "10",
      lifecycleState: "persisting",
      body: "Review OWL continued this Finding.",
      effectMarker: "<!-- diffowl:finding-update:v1 event=page-test -->",
    }),
  ).resolves.toMatchObject({ result: "complete", rootCommentId: "10" });
  expect(threadQueries).toBe(2);
});

it("publishes unanchored Finding discussion updates on the pull-request timeline", async () => {
  const requests: GitHubRequest[] = [];
  const transport = async (request: GitHubRequest): Promise<unknown> => {
    requests.push(request);
    if (request.method === "GET" && request.path.endsWith("/pulls/42")) {
      return { head: { sha: "head-sha" } };
    }
    if (request.method === "GET") return [];
    return { id: 99 };
  };

  await expect(
    publishFindingDiscussionUpdate(transport, {
      repository: "example/repository",
      pullRequestNumber: 42,
      headSha: "head-sha",
      rootCommentId: "finding-1",
      rootSurface: "issue_comment",
      lifecycleState: "persisting",
      body: "Review OWL rechecked this unanchored Finding.",
      effectMarker: "<!-- diffowl:finding-update:v1 event=finding-1 -->",
    }),
  ).resolves.toMatchObject({
    result: "complete",
    rootCommentId: "finding-1",
    replyCreated: true,
    threadResolved: false,
  });
  expect(requests).toContainEqual(
    expect.objectContaining({
      method: "POST",
      path: "/repos/example/repository/issues/42/comments",
      body: expect.objectContaining({
        body: expect.stringContaining("Review OWL rechecked this unanchored Finding."),
      }),
    }),
  );
  expect(requests.some((request) => request.path === "/graphql")).toBe(false);
});

it("reports incomplete publication at the GraphQL review-thread ceiling", async () => {
  let threadQueries = 0;
  const transport = async (request: GitHubRequest): Promise<unknown> => {
    if (request.method === "GET" && request.path.endsWith("/pulls/42")) {
      return { head: { sha: "head-sha" } };
    }
    if (request.method === "GET") return [];
    if (request.path.endsWith("/10/replies")) return {};
    threadQueries += 1;
    return {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array.from({ length: 100 }, (_, index) => ({
                id: `page-thread-${threadQueries}-${index}`,
                isResolved: false,
                comments: { nodes: [{ databaseId: 1_000 + index }] },
              })),
              pageInfo: { hasNextPage: true, endCursor: `page-${threadQueries}` },
            },
          },
        },
      },
    };
  };

  await expect(
    publishFindingDiscussionUpdate(transport, {
      repository: "example/repository",
      pullRequestNumber: 42,
      headSha: "head-sha",
      rootCommentId: "10",
      lifecycleState: "persisting",
      body: "Review OWL continued this Finding.",
      effectMarker: "<!-- diffowl:finding-update:v1 event=ceiling-test -->",
    }),
  ).resolves.toMatchObject({
    result: "incomplete",
    replyCreated: true,
    reason: "Unable to reconcile the Finding discussion within 1,000 review threads.",
  });
  expect(threadQueries).toBe(10);
});

it("records confirmed Finding reply effects when thread resolution is incomplete", async () => {
  const directory = await temporaryDirectories.create();
  const stateDirectory = join(directory, "state");
  const persistence = new FileSystemReviewPersistenceStore(stateDirectory);
  const fingerprint = `sha256:${"b".repeat(64)}`;
  await seedFindingCommand(persistence, fingerprint, "finding-incomplete", "rebut");
  const outputs = new Map<string, string>();
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const transport = async (request: GitHubRequest): Promise<unknown> => {
    if (request.method === "GET" && request.path.endsWith("/pulls/42")) {
      return { head: { sha: "head-sha" } };
    }
    if (request.method === "GET") return [];
    if (request.path.endsWith("/10/replies")) return {};
    if (request.path === "/graphql" && JSON.stringify(request.body).includes("reviewThreads")) {
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-10",
                    isResolved: false,
                    comments: { nodes: [{ databaseId: 10 }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      };
    }
    return { errors: [{ message: "thread resolution failed" }] };
  };
  const confirmed = {
    result: "incomplete" as const,
    headSha: "head-sha",
    rootCommentId: "10",
    replyCreated: true,
    threadResolved: false,
    inlineCommentCount: 0,
    unanchoredFindingCount: 0,
    reason: "GitHub review-thread disposition returned GraphQL errors.",
  };

  await expect(
    runAction(
      findingDispatchEnvironment(stateDirectory, "finding-incomplete", "1237"),
      verifiedDispatchIo({
        setOutput: async (name, value) => {
          outputs.set(name, value);
        },
        publishFindingDiscussion: (update) => publishFindingDiscussionUpdate(transport, update),
      }),
    ),
  ).rejects.toThrow("GitHub review-thread disposition returned GraphQL errors.");

  expect(JSON.parse(outputs.get("publication") ?? "{}")).toMatchObject(confirmed);
  await persistence.withTransaction(
    { repository: "example/repository", pullRequestNumber: 42 },
    async (transaction) => {
      expect(await transaction.loadPublicationEffects("command-finding-incomplete")).toMatchObject(
        confirmed,
      );
      expect(
        (await transaction.loadReviewRequests())?.requests["finding-incomplete"],
      ).toMatchObject({ status: "active", workflowRunId: "1237" });
    },
  );
});

it("refuses stale GitHub head state before Finding discussion effects", async () => {
  const directory = await temporaryDirectories.create();
  const stateDirectory = join(directory, "state");
  const persistence = new FileSystemReviewPersistenceStore(stateDirectory);
  const fingerprint = `sha256:${"e".repeat(64)}`;
  await seedFindingCommand(persistence, fingerprint, "finding-pre-stale");
  const requests: GitHubRequest[] = [];
  const outputs = new Map<string, string>();
  const transport = async (request: GitHubRequest): Promise<unknown> => {
    requests.push(request);
    if (request.method === "GET" && request.path.endsWith("/pulls/42")) {
      return { head: { sha: "new-head" } };
    }
    if (request.method === "GET") return [];
    return {};
  };

  await expect(
    runAction(
      findingDispatchEnvironment(stateDirectory, "finding-pre-stale", "1240"),
      verifiedDispatchIo({
        setOutput: async (name, value) => {
          outputs.set(name, value);
        },
        publishFindingDiscussion: (update) => publishFindingDiscussionUpdate(transport, update),
      }),
    ),
  ).rejects.toThrow("head changed before");
  expect(requests.some((request) => request.method === "POST")).toBe(false);
  expect(JSON.parse(outputs.get("publication") ?? "{}")).toMatchObject({ result: "refused" });
});

it("records confirmed replies when the GitHub head changes after effects", async () => {
  const directory = await temporaryDirectories.create();
  const stateDirectory = join(directory, "state");
  const persistence = new FileSystemReviewPersistenceStore(stateDirectory);
  const fingerprint = `sha256:${"f".repeat(64)}`;
  await seedFindingCommand(persistence, fingerprint, "finding-post-stale");
  const outputs = new Map<string, string>();
  let headReads = 0;
  const transport = async (request: GitHubRequest): Promise<unknown> => {
    if (request.method === "GET" && request.path.endsWith("/pulls/42")) {
      headReads += 1;
      return { head: { sha: headReads === 1 ? "head-sha" : "new-head" } };
    }
    if (request.method === "GET") return [];
    if (request.path.endsWith("/10/replies")) return {};
    if (request.path === "/graphql") {
      return {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [
                  {
                    id: "thread-10",
                    isResolved: false,
                    comments: { nodes: [{ databaseId: 10 }] },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        },
      };
    }
    return {};
  };

  await expect(
    runAction(
      findingDispatchEnvironment(stateDirectory, "finding-post-stale", "1241"),
      verifiedDispatchIo({
        setOutput: async (name, value) => {
          outputs.set(name, value);
        },
        publishFindingDiscussion: (update) => publishFindingDiscussionUpdate(transport, update),
      }),
    ),
  ).rejects.toThrow("head changed after");
  expect(JSON.parse(outputs.get("publication") ?? "{}")).toMatchObject({
    result: "incomplete",
    replyCreated: true,
  });
});

// jscpd:ignore-end
it("refuses a stale Finding reassessment before mutating or publishing", async () => {
  const directory = await temporaryDirectories.create();
  const stateDirectory = join(directory, "state");
  const persistence = new FileSystemReviewPersistenceStore(stateDirectory);
  const fingerprint = `sha256:${"c".repeat(64)}`;
  await seedFindingCommand(persistence, fingerprint, "finding-stale", "reassess");
  let published = false;

  await expect(
    runAction(
      findingDispatchEnvironment(stateDirectory, "finding-stale", "1238"),
      verifiedDispatchIo({
        executeRole: async (request) => {
          await persistence.withTransaction(
            { repository: "example/repository", pullRequestNumber: 42 },
            async (transaction) => {
              const ledger = (await transaction.loadLedger())!;
              ledger.entries[0]!.reviewedHeadSha = "newer-head";
              await transaction.saveLedger(ledger);
            },
          );
          return emptyRoleResult(request);
        },
        publishFindingDiscussion: async () => {
          published = true;
          throw new Error("must not publish");
        },
      }),
    ),
  ).rejects.toThrow("no longer matches the current reviewed revision");

  expect(published).toBe(false);
  await persistence.withTransaction(
    { repository: "example/repository", pullRequestNumber: 42 },
    async (transaction) => {
      expect((await transaction.loadLedger())?.entries[0]).toMatchObject({
        reviewedHeadSha: "newer-head",
        lifecycleState: "persisting",
      });
    },
  );
});

it("does not let older same-Finding work mutate after a newer command supersedes it", async () => {
  const directory = await temporaryDirectories.create();
  const stateDirectory = join(directory, "state");
  const persistence = new FileSystemReviewPersistenceStore(stateDirectory);
  const fingerprint = `sha256:${"7".repeat(64)}`;
  await seedFindingCommand(persistence, fingerprint, "finding-old", "reassess");
  let published = false;

  await expect(
    runAction(
      findingDispatchEnvironment(stateDirectory, "finding-old", "old-workflow"),
      verifiedDispatchIo({
        executeRole: async (request) => {
          await persistence.withTransaction(
            { repository: "example/repository", pullRequestNumber: 42 },
            async (transaction) => {
              const ledger = (await transaction.loadReviewRequests())!;
              ledger.requests["finding-old"] = {
                ...ledger.requests["finding-old"]!,
                status: "superseded",
              };
              ledger.events["finding-new"] = {
                eventId: "finding-new",
                actor: "octocat",
                command: "resolved",
                observedAt: "2026-08-15T00:01:00.000Z",
                headSha: "head-sha",
                workType: "finding_discussion",
                findingFingerprint: fingerprint,
                rootCommentId: "10",
                reviewedHeadSha: "head-sha",
                decision: "dispatch",
                requestId: "finding-new",
              };
              ledger.requests["finding-new"] = {
                requestId: "finding-new",
                headSha: "head-sha",
                status: "queued",
                requestedAt: "2026-08-15T00:01:00.000Z",
              };
              await transaction.saveReviewRequests(ledger);
            },
          );
          return emptyRoleResult(request);
        },
        publishFindingDiscussion: async () => {
          published = true;
          throw new Error("must not publish stale work");
        },
      }),
    ),
  ).rejects.toThrow("superseded");

  expect(published).toBe(false);
  await persistence.withTransaction(
    { repository: "example/repository", pullRequestNumber: 42 },
    async (transaction) => {
      expect((await transaction.loadLedger())?.entries[0]?.lifecycleState).toBe("persisting");
    },
  );
});

it("claims an accepted dispatch, runs the canonical review path, and records completion", async () => {
  const directory = await temporaryDirectories.create();
  const stateDirectory = join(directory, "state");
  const persistence = new FileSystemReviewPersistenceStore(stateDirectory);
  await persistence.withTransaction(
    { repository: "example/repository", pullRequestNumber: 42 },
    async (transaction) => {
      await transaction.saveReviewRequests({
        version: 1,
        events: {
          "9002": {
            eventId: "9002",
            actor: "octocat",
            command: "review",
            observedAt: "2026-08-15T00:00:00.000Z",
            headSha: "head-sha",
            decision: "dispatch",
            requestId: "9002",
            eyesAt: "2026-08-15T00:00:00.000Z",
            dispatchedAt: "2026-08-15T00:00:00.000Z",
          },
        },
        requests: {
          "9002": {
            requestId: "9002",
            headSha: "head-sha",
            status: "queued",
            requestedAt: "2026-08-15T00:00:00.000Z",
          },
        },
      });
    },
  );
  let reviewed = false;
  const io = verifiedDispatchIo({
    readDiff: async () => {
      reviewed = true;
      return [
        "diff --git a/src/message.ts b/src/message.ts",
        "--- a/src/message.ts",
        "+++ b/src/message.ts",
        "@@ -1 +1 @@",
        "-hello",
        "+hello owl",
      ].join("\n");
    },
    executeRole: async (request) => emptyRoleResult(request),
  });

  const outcome = await runAction(
    {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      INPUT_REPOSITORY: "example/repository",
      "INPUT_PULL-REQUEST-NUMBER": "42",
      "INPUT_BASE-SHA": "base-sha",
      "INPUT_HEAD-SHA": "head-sha",
      "INPUT_REVIEW-REQUEST-EVENT-ID": "9002",
      "INPUT_SELF-HOSTED-STATE-DIRECTORY": stateDirectory,
      GITHUB_RUN_ID: "1235",
    },
    io,
  );

  expect(reviewed).toBe(true);
  expect(outcome).toMatchObject({
    pullRequest: { repository: "example/repository", number: 42, headSha: "head-sha" },
  });
  await persistence.withTransaction(
    { repository: "example/repository", pullRequestNumber: 42 },
    async (transaction) => {
      expect((await transaction.loadReviewRequests())?.requests["9002"]).toMatchObject({
        status: "terminal",
        workflowRunId: "1235",
      });
    },
  );
});
