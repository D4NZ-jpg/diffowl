/* oxlint-disable max-lines-per-function */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { type ActionIo, runAction } from "../src/action.js";
import { FileSystemReviewPersistenceStore } from "../src/persistence.js";
import { temporaryStateDirectories } from "./persistence-fixtures.js";
import { emptyRoleResult, projectPolicy } from "./review-fixtures.js";

const temporaryDirectories = temporaryStateDirectories("diffowl-action-request-");

afterEach(temporaryDirectories.removeAll);

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
      "INPUT_STATE-DIRECTORY": join(directory, "state"),
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
            deprecatedAlias: false,
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
  const io: ActionIo = {
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
    readPolicy: async () => JSON.stringify(projectPolicy()),
    setOutput: async () => {},
    executeRole: async (request) => emptyRoleResult(request),
  };

  const outcome = await runAction(
    {
      GITHUB_EVENT_NAME: "workflow_dispatch",
      INPUT_REPOSITORY: "example/repository",
      "INPUT_PULL-REQUEST-NUMBER": "42",
      "INPUT_BASE-SHA": "base-sha",
      "INPUT_HEAD-SHA": "head-sha",
      "INPUT_REVIEW-REQUEST-EVENT-ID": "9002",
      "INPUT_STATE-DIRECTORY": stateDirectory,
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
