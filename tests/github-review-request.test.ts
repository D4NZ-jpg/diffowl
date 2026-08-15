import { afterEach, expect, it } from "vitest";

import { createGitHubReviewRequestIo } from "../src/github-review-request.js";
import type { GitHubRequest } from "../src/github-publication.js";
import { FileSystemReviewPersistenceStore } from "../src/persistence.js";
import { routeReviewRequest } from "../src/review-request.js";
import { temporaryStateDirectories } from "./persistence-fixtures.js";
import { projectPolicy } from "./review-fixtures.js";

const temporaryDirectories = temporaryStateDirectories("diffowl-github-request-");

afterEach(temporaryDirectories.removeAll);

it("routes GitHub effects to the default-branch workflow with the verified head", async () => {
  const requests: GitHubRequest[] = [];
  const transport = async (request: GitHubRequest): Promise<unknown> => {
    requests.push(request);
    if (request.method === "GET" && request.path === "/repos/example/repository/pulls/42") {
      return {
        number: 42,
        user: { login: "octocat" },
        base: { sha: "base-sha", repo: { full_name: "example/repository" } },
        head: { sha: "head-sha", repo: { full_name: "example/repository" } },
      };
    }
    if (request.method === "GET" && request.path.endsWith("/comments?per_page=100")) return [];
    return {};
  };
  const directory = await temporaryDirectories.create();
  const persistence = new FileSystemReviewPersistenceStore(directory);
  const io = createGitHubReviewRequestIo(transport, {
    repository: "example/repository",
    pullRequestNumber: 42,
    workflow: "review-owl.yml",
    readPolicy: async () => JSON.stringify(projectPolicy()),
  });

  await routeReviewRequest(
    {
      eventId: "9001",
      repository: "example/repository",
      defaultBranch: "main",
      pullRequestNumber: 42,
      actor: "octocat",
      body: "/diffowl review",
    },
    io,
    persistence,
    new Date("2026-08-15T00:00:00.000Z"),
  );

  expect(requests).toContainEqual({
    method: "POST",
    path: "/repos/example/repository/issues/comments/9001/reactions",
    body: { content: "eyes" },
  });
  expect(requests).toContainEqual({
    method: "POST",
    path: "/repos/example/repository/actions/workflows/review-owl.yml/dispatches",
    body: {
      ref: "main",
      inputs: {
        repository: "example/repository",
        "pull-request-number": "42",
        "base-sha": "base-sha",
        "head-sha": "head-sha",
        "review-request-event-id": "9001",
      },
    },
  });
});

it("reconciles a refusal marker beyond the first comment page", async () => {
  const requests: GitHubRequest[] = [];
  const marker = "<!-- diffowl-review-request:9002:refusal -->";
  const io = createGitHubReviewRequestIo(
    async (request) => {
      requests.push(request);
      if (request.path.endsWith("page=1")) {
        return Array.from({ length: 100 }, () => ({ body: "older comment" }));
      }
      return [{ body: marker }];
    },
    {
      repository: "example/repository",
      pullRequestNumber: 42,
      workflow: "review-owl.yml",
      readPolicy: async () => undefined,
    },
  );

  await io.replyOnce("9002", "Refused.");

  expect(requests).toHaveLength(2);
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});

it("classifies a non-collaborator permission response as untrusted", async () => {
  const io = createGitHubReviewRequestIo(
    async () => {
      throw new Error("GitHub API GET permission failed (404).");
    },
    {
      repository: "example/repository",
      pullRequestNumber: 42,
      workflow: "review-owl.yml",
      readPolicy: async () => undefined,
    },
  );

  await expect(io.readPermission("example/repository", "outsider")).resolves.toBe("none");
});
