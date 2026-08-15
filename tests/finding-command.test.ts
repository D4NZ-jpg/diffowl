/* oxlint-disable max-lines */
import { afterEach, expect, it } from "vitest";

import {
  routeFindingCommand,
  type FindingCommandEvent,
  type FindingCommandIo,
  type FindingCommandReviewComment,
} from "../src/finding-command.js";
import { findingIdentityMarker } from "../src/finding-discussion.js";
import { FileSystemReviewPersistenceStore } from "../src/persistence.js";
import { temporaryStateDirectories } from "./persistence-fixtures.js";
import { projectPolicy } from "./review-fixtures.js";

const directories = temporaryStateDirectories("diffowl-finding-command-");
const fingerprint = `sha256:${"a".repeat(64)}`;
const key = { repository: "example/repository", pullRequestNumber: 42 };

const root: FindingCommandReviewComment = {
  id: "10",
  actor: "github-actions[bot]",
  body: `${findingIdentityMarker(fingerprint)}\n### Review OWL material Finding`,
  createdAt: "2026-08-15T00:00:00.000Z",
  isBot: true,
};
const nested: FindingCommandReviewComment = {
  id: "20",
  actor: "reviewer",
  body: "Can you recheck this?",
  createdAt: "2026-08-15T00:01:00.000Z",
  inReplyToId: "10",
};

afterEach(directories.removeAll);

async function store(reviewedHeadSha = "head-sha") {
  const persistence = new FileSystemReviewPersistenceStore(await directories.create());
  await persistence.withTransaction(key, async (transaction) => {
    await transaction.saveLedger({
      version: 1,
      entries: [
        {
          fingerprint,
          summary: "Finding",
          locationPath: "src/example.ts",
          reviewedHeadSha,
          lifecycleState: "persisting",
          firstSeenRunId: "run-1",
          lastChangedRunId: "run-1",
          lastSeenRunId: "run-1",
        },
      ],
    });
  });
  return persistence;
}

function event(overrides: Partial<FindingCommandEvent> = {}): FindingCommandEvent {
  return {
    id: "30",
    actor: "octocat",
    body: "/diffowl reassess This endpoint is administrator-only.",
    createdAt: "2026-08-15T00:02:00.000Z",
    inReplyToId: "20",
    repository: "example/repository",
    defaultBranch: "main",
    pullRequestNumber: 42,
    ...overrides,
  };
}

function io(effects: string[], overrides: Partial<FindingCommandIo> = {}): FindingCommandIo {
  const comments = new Map([
    [root.id, root],
    [nested.id, nested],
  ]);
  return {
    readPullRequest: async () => ({
      number: 42,
      author: "octocat",
      baseSha: "base-sha",
      headSha: "head-sha",
      baseRepository: "example/repository",
      headRepository: "example/repository",
    }),
    readPolicy: async () => JSON.stringify(projectPolicy()),
    readReviewComment: async (_repository, commentId) => comments.get(commentId)!,
    addEyes: async (eventId) => {
      effects.push(`eyes:${eventId}`);
    },
    replyOnce: async (_eventId, _rootCommentId, message) => {
      effects.push(`reply:${message}`);
    },
    dispatchReview: async (request) => {
      effects.push(`dispatch:${request.workType}:${request.command}:${request.findingFingerprint}`);
    },
    ...overrides,
  };
}

it("records a nested in-thread command before dispatching bounded Finding work", async () => {
  const persistence = await store();
  const effects: string[] = [];
  const commandIo = io(effects, {
    addEyes: async () => {
      await persistence.withTransaction(key, async (transaction) => {
        expect((await transaction.loadReviewRequests())?.events["30"]).toMatchObject({
          command: "reassess",
          workType: "finding_discussion",
          findingFingerprint: fingerprint,
          rootCommentId: "10",
        });
        expect((await transaction.loadLedger())?.entries[0]?.discussion).toEqual([
          expect.objectContaining({
            id: "30",
            command: "reassess",
            body: "This endpoint is administrator-only.",
          }),
        ]);
      });
      effects.push("eyes:30");
    },
  });

  const result = await routeFindingCommand(
    event(),
    commandIo,
    persistence,
    new Date("2026-08-15T00:02:00.000Z"),
  );

  expect(result).toEqual({
    type: "dispatched",
    headSha: "head-sha",
    workType: "finding_discussion",
    fingerprint,
  });
  expect(effects).toEqual(["eyes:30", `dispatch:finding_discussion:reassess:${fingerprint}`]);
});

it("routes existing lifecycle commands through bounded Finding discussion work", async () => {
  const persistence = await store();
  const effects: string[] = [];

  const result = await routeFindingCommand(
    event({ body: "/diffowl accept" }),
    io(effects),
    persistence,
  );

  expect(result).toMatchObject({ type: "dispatched", workType: "finding_discussion", fingerprint });
  expect(effects).toEqual(["eyes:30", `dispatch:finding_discussion:accept:${fingerprint}`]);
});

it("routes a Finding command through the canonical full Review when the head is newer", async () => {
  const persistence = await store("reviewed-head");
  const effects: string[] = [];

  const result = await routeFindingCommand(
    event({ body: "/diffowl recheck" }),
    io(effects),
    persistence,
  );

  expect(result).toMatchObject({ type: "dispatched", workType: "full_review", fingerprint });
  expect(effects).toEqual(["eyes:30", `dispatch:full_review:recheck:${fingerprint}`]);
});

it("makes duplicate event delivery idempotent", async () => {
  const persistence = await store();
  const effects: string[] = [];
  const commandIo = io(effects);

  await routeFindingCommand(event(), commandIo, persistence);
  await routeFindingCommand(event(), commandIo, persistence);

  expect(effects).toEqual(["eyes:30", `dispatch:finding_discussion:reassess:${fingerprint}`]);
  await persistence.withTransaction(key, async (transaction) => {
    expect((await transaction.loadLedger())?.entries[0]?.discussion).toHaveLength(1);
  });
});

// oxlint-disable-next-line max-lines-per-function
it("applies Finding command cooldowns per stable Finding identity", async () => {
  const persistence = await store();
  const otherFingerprint = `sha256:${"b".repeat(64)}`;
  const otherRoot = {
    ...root,
    id: "11",
    body: `${findingIdentityMarker(otherFingerprint)}\n### Review OWL material Finding`,
  };
  await persistence.withTransaction(key, async (transaction) => {
    const ledger = (await transaction.loadLedger())!;
    ledger.entries.push({
      ...ledger.entries[0]!,
      fingerprint: otherFingerprint,
      summary: "Other Finding",
    });
    await transaction.saveLedger(ledger);
    await transaction.saveReviewRequests({
      version: 1,
      events: {
        previous: {
          eventId: "previous",
          actor: "octocat",
          command: "reassess",
          deprecatedAlias: false,
          observedAt: "2026-08-15T00:01:00.000Z",
          headSha: "head-sha",
          workType: "finding_discussion",
          findingFingerprint: fingerprint,
          findingContext: "Previous context",
          rootCommentId: "10",
          reviewedHeadSha: "head-sha",
          decision: "dispatch",
          requestId: "previous",
        },
      },
      requests: {
        previous: {
          requestId: "previous",
          headSha: "head-sha",
          status: "terminal",
          requestedAt: "2026-08-15T00:01:00.000Z",
          completedAt: "2026-08-15T00:01:30.000Z",
        },
      },
    });
  });
  const effects: string[] = [];
  const result = await routeFindingCommand(
    event({ id: "31", inReplyToId: "11", createdAt: "2026-08-15T00:02:00.000Z" }),
    io(effects, {
      readReviewComment: async (_repository, commentId) =>
        commentId === otherRoot.id ? otherRoot : nested,
    }),
    persistence,
  );

  expect(result).toMatchObject({
    type: "dispatched",
    workType: "finding_discussion",
    fingerprint: otherFingerprint,
  });
  expect(effects).toEqual(["eyes:31", `dispatch:finding_discussion:reassess:${otherFingerprint}`]);
});

it("refuses delayed same-Finding commands and supersedes older active work", async () => {
  const persistence = await store();
  const effects: string[] = [];
  const commandIo = io(effects);

  await routeFindingCommand(
    event({ id: "31", createdAt: "2026-08-15T00:03:00.000Z" }),
    commandIo,
    persistence,
  );
  const delayed = await routeFindingCommand(
    event({ id: "30", createdAt: "2026-08-15T00:02:00.000Z" }),
    commandIo,
    persistence,
  );

  expect(delayed).toEqual({
    type: "refused",
    reason: "A newer command superseded this Finding discussion request.",
  });
  await persistence.withTransaction(key, async (transaction) => {
    const requests = (await transaction.loadReviewRequests())?.requests;
    expect(requests?.["31"]?.status).toBe("queued");
    expect(requests?.["30"]).toBeUndefined();
  });

  const persistence2 = await store();
  await routeFindingCommand(
    event({ id: "40", createdAt: "2026-08-15T00:04:00.000Z" }),
    io([]),
    persistence2,
  );
  await persistence2.withTransaction(key, async (transaction) => {
    const requestLedger = (await transaction.loadReviewRequests())!;
    requestLedger.requests["40"] = {
      ...requestLedger.requests["40"]!,
      status: "active",
      activatedAt: "2026-08-15T00:04:00.000Z",
      workflowRunId: "old-run",
    };
    await transaction.saveReviewRequests(requestLedger);
  });
  await routeFindingCommand(
    event({ id: "41", createdAt: "2026-08-15T00:05:00.000Z" }),
    io([]),
    persistence2,
  );
  await persistence2.withTransaction(key, async (transaction) => {
    expect((await transaction.loadReviewRequests())?.requests["40"]?.status).toBe("superseded");
  });
});

it("records and explains authorization failure without dispatch", async () => {
  const persistence = await store();
  const effects: string[] = [];
  const commandIo = io(effects);

  const result = await routeFindingCommand(event({ actor: "reviewer" }), commandIo, persistence);

  expect(result).toEqual({
    type: "refused",
    reason: "Diffowl Finding commands must be authored by the pull-request author.",
  });
  expect(effects).toEqual([
    "reply:Diffowl Finding commands must be authored by the pull-request author.",
  ]);
});

it("rejects a forged root marker that was not authored by Review OWL", async () => {
  const persistence = await store();
  const effects: string[] = [];
  const forged = { ...root, actor: "octocat", isBot: false };
  const commandIo = io(effects, {
    readReviewComment: async (_repository, commentId) =>
      commentId === forged.id ? forged : nested,
  });

  const result = await routeFindingCommand(
    event({ inReplyToId: forged.id }),
    commandIo,
    persistence,
  );

  expect(result).toEqual({
    type: "refused",
    reason: "The review comment is not a reply inside an engine-owned Diffowl Finding discussion.",
  });
  expect(effects).toEqual([
    "reply:The review comment is not a reply inside an engine-owned Diffowl Finding discussion.",
  ]);
});
