/* oxlint-disable max-lines, max-lines-per-function */
import { afterEach, expect, it } from "vitest";

import { FileSystemReviewPersistenceStore } from "../src/persistence.js";
import {
  claimReviewRequest,
  reviewRequestIsActive,
  routeReviewRequest,
  type RepositoryPermission,
  type ReviewRequestEvent,
  type ReviewRequestIo,
  type ReviewRequestPullRequest,
} from "../src/review-request.js";
import { temporaryStateDirectories } from "./persistence-fixtures.js";
import { projectPolicy } from "./review-fixtures.js";

const stateDirectories = temporaryStateDirectories("diffowl-review-request-");
const key = { repository: "example/repository", pullRequestNumber: 42 };

afterEach(stateDirectories.removeAll);

async function stateStore(): Promise<FileSystemReviewPersistenceStore> {
  return new FileSystemReviewPersistenceStore(await stateDirectories.create());
}

const policy = JSON.stringify(projectPolicy());

function pullRequest(overrides: Partial<ReviewRequestPullRequest> = {}): ReviewRequestPullRequest {
  return {
    number: 42,
    author: "octocat",
    baseSha: "base-sha",
    headSha: "head-sha",
    baseRepository: "example/repository",
    headRepository: "example/repository",
    ...overrides,
  };
}

function event(eventId: string, overrides: Partial<ReviewRequestEvent> = {}): ReviewRequestEvent {
  return {
    eventId,
    repository: "example/repository",
    defaultBranch: "main",
    pullRequestNumber: 42,
    actor: "octocat",
    body: "/diffowl review",
    ...overrides,
  };
}

function reviewIo(overrides: Partial<ReviewRequestIo> = {}): ReviewRequestIo {
  return {
    readPullRequest: async () => pullRequest(),
    readPermission: async () => "read",
    readPolicy: async () => policy,
    addEyes: async () => {},
    replyOnce: async () => {},
    dispatchReview: async () => {},
    ...overrides,
  };
}

it("records an authorized Review request before acknowledging and dispatching it", async () => {
  const persistence = await stateStore();
  const effects: string[] = [];
  const assertRecorded = async () => {
    await persistence.withTransaction(key, async (transaction) => {
      expect((await transaction.loadReviewRequests())?.events["9001"]).toMatchObject({
        actor: "octocat",
        command: "review",
        decision: "dispatch",
        headSha: "head-sha",
      });
    });
  };
  const io = reviewIo({
    addEyes: async () => {
      await assertRecorded();
      effects.push("eyes");
    },
    replyOnce: async () => {
      throw new Error("An accepted Review request must not receive a reply.");
    },
    dispatchReview: async (request) => {
      await assertRecorded();
      effects.push(`dispatch:${request.ref}:${request.headSha}`);
    },
  });

  const result = await routeReviewRequest(
    event("9001"),
    io,
    persistence,
    new Date("2026-08-15T00:00:00.000Z"),
  );

  expect(result).toEqual({ type: "dispatched", headSha: "head-sha", deprecatedAlias: false });
  expect(effects).toEqual(["eyes", "dispatch:main:head-sha"]);
});

it("records and explains refusal to a read-only non-author before any effect", async () => {
  const persistence = await stateStore();
  const effects: string[] = [];
  const reason =
    "Diffowl Review requests require the pull-request author or write, maintain, or admin access.";
  const io = reviewIo({
    readPullRequest: async () => pullRequest({ author: "author" }),
    addEyes: async () => {
      throw new Error("A refused Review request must not be acknowledged.");
    },
    replyOnce: async (_eventId, message) => {
      await persistence.withTransaction(key, async (transaction) => {
        expect((await transaction.loadReviewRequests())?.events["9002"]).toMatchObject({
          decision: "refuse",
          reason,
        });
      });
      effects.push(`reply:${message}`);
    },
    dispatchReview: async () => {
      throw new Error("A refused Review request must not be dispatched.");
    },
  });

  const result = await routeReviewRequest(
    event("9002", { actor: "reader" }),
    io,
    persistence,
    new Date("2026-08-15T00:00:00.000Z"),
  );

  expect(result).toEqual({ type: "refused", reason });
  expect(effects).toEqual([`reply:${reason}`]);
});

it("coalesces an active Review request for the same head", async () => {
  const persistence = await stateStore();
  const effects: string[] = [];
  const io = reviewIo({
    addEyes: async (eventId) => {
      effects.push(`eyes:${eventId}`);
    },
    dispatchReview: async (request) => {
      effects.push(`dispatch:${request.eventId}`);
    },
  });

  await routeReviewRequest(event("9003"), io, persistence);
  const duplicate = await routeReviewRequest(event("9004"), io, persistence);

  expect(duplicate).toEqual({
    type: "coalesced",
    headSha: "head-sha",
    deprecatedAlias: false,
  });
  expect(effects).toEqual(["eyes:9003", "dispatch:9003", "eyes:9004"]);
});

it("does not coalesce a full Review onto same-head Finding command work", async () => {
  const persistence = await stateStore();
  const findingFingerprint = `sha256:${"a".repeat(64)}`;
  await persistence.withTransaction(key, async (transaction) => {
    await transaction.saveReviewRequests({
      version: 1,
      events: {
        finding: {
          eventId: "finding",
          actor: "octocat",
          command: "recheck",
          deprecatedAlias: false,
          observedAt: "2026-08-15T00:00:00.000Z",
          headSha: "head-sha",
          workType: "finding_discussion",
          findingFingerprint,
          rootCommentId: "10",
          reviewedHeadSha: "head-sha",
          decision: "dispatch",
          requestId: "finding",
        },
      },
      requests: {
        finding: {
          requestId: "finding",
          headSha: "head-sha",
          status: "queued",
          requestedAt: "2026-08-15T00:00:00.000Z",
        },
      },
    });
  });
  const dispatched: string[] = [];

  const result = await routeReviewRequest(
    event("review", { createdAt: "2026-08-15T00:00:01.000Z" }),
    reviewIo({
      dispatchReview: async (request) => {
        dispatched.push(request.eventId);
      },
    }),
    persistence,
  );

  expect(result.type).toBe("dispatched");
  expect(dispatched).toEqual(["review"]);
  await persistence.withTransaction(key, async (transaction) => {
    expect((await transaction.loadReviewRequests())?.events.review).toMatchObject({
      command: "review",
      decision: "dispatch",
      requestId: "review",
    });
  });
});

it("recovers a failed dispatch when a same-head request coalesces", async () => {
  const persistence = await stateStore();
  const attempts: string[] = [];
  let fail = true;
  const io = reviewIo({
    dispatchReview: async (request) => {
      attempts.push(request.eventId);
      if (fail) throw new Error("dispatch unavailable");
    },
  });

  await expect(routeReviewRequest(event("failed-dispatch"), io, persistence)).rejects.toThrow(
    "dispatch unavailable",
  );
  fail = false;
  const result = await routeReviewRequest(event("retry-command"), io, persistence);

  expect(result.type).toBe("coalesced");
  expect(attempts).toEqual(["failed-dispatch", "failed-dispatch"]);
});

it("supersedes an interrupted same-head request after the review timeout", async () => {
  const persistence = await stateStore();
  await persistence.withTransaction(key, async (transaction) => {
    await transaction.saveReviewRequests({
      version: 1,
      events: {
        interrupted: {
          eventId: "interrupted",
          actor: "octocat",
          command: "review",
          deprecatedAlias: false,
          observedAt: "2026-08-15T00:00:00.000Z",
          headSha: "head-sha",
          decision: "dispatch",
          requestId: "interrupted",
        },
      },
      requests: {
        interrupted: {
          requestId: "interrupted",
          headSha: "head-sha",
          status: "queued",
          requestedAt: "2026-08-15T00:00:00.000Z",
        },
      },
    });
  });

  await claimReviewRequest(
    persistence,
    key,
    "interrupted",
    "head-sha",
    "old-run",
    new Date("2026-08-15T00:00:00.000Z"),
  );
  const result = await routeReviewRequest(
    event("replacement"),
    reviewIo(),
    persistence,
    new Date("2026-08-15T00:10:01.000Z"),
  );

  expect(result.type).toBe("dispatched");
  await persistence.withTransaction(key, async (transaction) => {
    expect((await transaction.loadReviewRequests())?.requests.interrupted?.status).toBe(
      "superseded",
    );
  });
  await expect(reviewRequestIsActive(persistence, key, "interrupted", "old-run")).resolves.toBe(
    false,
  );
});

it("refuses a completed same-head Review request during the Project-policy cooldown", async () => {
  const persistence = await stateStore();
  await persistence.withTransaction(key, async (transaction) => {
    await transaction.saveReviewRequests({
      version: 1,
      events: {
        previous: {
          eventId: "previous",
          actor: "octocat",
          command: "review",
          deprecatedAlias: false,
          observedAt: "2026-08-15T00:00:00.000Z",
          headSha: "head-sha",
          decision: "dispatch",
          requestId: "previous",
        },
      },
      requests: {
        previous: {
          requestId: "previous",
          headSha: "head-sha",
          status: "terminal",
          requestedAt: "2026-08-15T00:00:00.000Z",
          completedAt: "2026-08-15T00:01:00.000Z",
        },
      },
    });
  });
  const replies: string[] = [];
  const io = reviewIo({
    readPolicy: async () =>
      JSON.stringify({ ...JSON.parse(policy), reviewRequests: { cooldownSeconds: 60 } }),
    replyOnce: async (_eventId, message) => {
      replies.push(message);
    },
  });

  const result = await routeReviewRequest(
    event("9005"),
    io,
    persistence,
    new Date("2026-08-15T00:01:30.000Z"),
  );

  const reason = "Diffowl reviewed this head recently; try again after the 60-second cooldown.";
  expect(result).toEqual({ type: "refused", reason });
  expect(replies).toEqual([reason]);
});

it("routes the deprecated alias through the canonical Review request path", async () => {
  const persistence = await stateStore();
  const dispatched: string[] = [];
  const io = reviewIo({
    dispatchReview: async (request) => {
      dispatched.push(request.eventId);
    },
  });

  const result = await routeReviewRequest(
    event("9006", { body: "/diffowl rerun" }),
    io,
    persistence,
  );

  expect(result).toEqual({ type: "dispatched", headSha: "head-sha", deprecatedAlias: true });
  expect(dispatched).toEqual(["9006"]);
});

it("supersedes stale work when a Review request observes a newer head", async () => {
  const persistence = await stateStore();
  let headSha = "old-head";
  const io = reviewIo({ readPullRequest: async () => pullRequest({ headSha }) });

  await routeReviewRequest(event("9007"), io, persistence);
  headSha = "new-head";
  const result = await routeReviewRequest(event("9008"), io, persistence);

  expect(result).toMatchObject({ type: "dispatched", headSha: "new-head" });
  await persistence.withTransaction(key, async (transaction) => {
    const requests = (await transaction.loadReviewRequests())?.requests;
    expect(requests?.["9007"]?.status).toBe("superseded");
    expect(requests?.["9008"]?.status).toBe("queued");
  });
});

it("uses the default cooldown when Review-request policy is empty", async () => {
  const persistence = await stateStore();
  const io = reviewIo({
    readPolicy: async () => JSON.stringify({ ...JSON.parse(policy), reviewRequests: {} }),
  });

  await expect(routeReviewRequest(event("default-policy"), io, persistence)).resolves.toMatchObject(
    {
      type: "dispatched",
    },
  );
});

it("refuses a delayed old-head command after a newer request commits", async () => {
  const persistence = await stateStore();
  let headSha = "new-head";
  const io = reviewIo({ readPullRequest: async () => pullRequest({ headSha }) });

  await routeReviewRequest(
    event("newer-command", { createdAt: "2026-08-15T00:00:02.000Z" }),
    io,
    persistence,
    new Date("2026-08-15T00:00:01.000Z"),
  );
  headSha = "old-head";
  const delayed = await routeReviewRequest(
    event("delayed-command", { createdAt: "2026-08-15T00:00:01.000Z" }),
    io,
    persistence,
    new Date("2026-08-15T00:00:03.000Z"),
  );

  expect(delayed).toEqual({
    type: "refused",
    reason: "A newer pull-request revision superseded this Review request.",
  });
  await persistence.withTransaction(key, async (transaction) => {
    expect((await transaction.loadReviewRequests())?.requests["newer-command"]?.status).toBe(
      "queued",
    );
  });
});

it("rejects a Project-policy cooldown below the security minimum", async () => {
  const persistence = await stateStore();
  const replies: string[] = [];
  const io = reviewIo({
    readPolicy: async () =>
      JSON.stringify({ ...JSON.parse(policy), reviewRequests: { cooldownSeconds: 59 } }),
    replyOnce: async (_eventId, message) => {
      replies.push(message);
    },
  });

  const result = await routeReviewRequest(event("9009"), io, persistence);

  expect(result).toEqual({
    type: "refused",
    reason: "Project policy reviewRequests.cooldownSeconds is below the security minimum of 60.",
  });
  expect(replies).toHaveLength(1);
});

it.each([
  ["a write collaborator", "maintainer", "author", "write", "example/repository", "dispatched"],
  ["a triage-only non-author", "triager", "author", "triage", "example/repository", "refused"],
  ["a fork pull-request author", "author", "author", "read", "fork/repository", "refused"],
  ["Dependabot", "dependabot[bot]", "dependabot[bot]", "write", "example/repository", "refused"],
] as const)(
  "authorizes %s without elevating trust",
  async (_name, actor, author, permission, headRepository, expected) => {
    const persistence = await stateStore();
    const effects: string[] = [];
    const io = reviewIo({
      readPullRequest: async () => pullRequest({ author, headRepository }),
      readPermission: async () => permission as RepositoryPermission,
      addEyes: async () => {
        effects.push("eyes");
      },
      replyOnce: async () => {
        effects.push("reply");
      },
      dispatchReview: async () => {
        effects.push("dispatch");
      },
    });

    const result = await routeReviewRequest(
      event(`authority-${actor}`, { actor }),
      io,
      persistence,
    );

    expect(result.type).toBe(expected);
    expect(effects).toEqual(expected === "dispatched" ? ["eyes", "dispatch"] : ["reply"]);
  },
);
