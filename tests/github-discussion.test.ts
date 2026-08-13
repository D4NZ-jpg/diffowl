import { expect, it } from "vitest";

import { listFindingDiscussionComments } from "../src/github-discussion.js";
import type { GitHubRequest } from "../src/github-publication.js";

function reviewComment(id: number, body: string, inReplyTo?: number) {
  return {
    id,
    body,
    created_at: "2026-01-01T00:00:00.000Z",
    user: { login: "author" },
    ...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }),
  };
}

it("paginates pull-request review comments and preserves thread body", async () => {
  const requests: GitHubRequest[] = [];
  const comments = await listFindingDiscussionComments(
    async (request) => {
      requests.push(request);
      if (request.path.endsWith("page=1")) {
        return Array.from({ length: 100 }, (_, index) => reviewComment(index + 1, "root"));
      }
      return [reviewComment(101, "/review-owl resolved", 1)];
    },
    "example/repo",
    42,
  );

  expect(requests.map((request) => request.path)).toEqual([
    "/repos/example/repo/pulls/42/comments?per_page=100&page=1",
    "/repos/example/repo/pulls/42/comments?per_page=100&page=2",
  ]);
  expect(comments.at(-1)).toMatchObject({
    id: 101,
    body: "/review-owl resolved",
    threadBody: "root",
  });
});
