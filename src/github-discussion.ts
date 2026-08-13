import type { FindingDiscussionComment } from "./finding-discussion.js";
import type { GitHubTransport } from "./github-publication.js";

function reviewComment(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const user = record.user as Record<string, unknown> | undefined;
  return typeof record.id === "number" &&
    typeof record.body === "string" &&
    typeof record.created_at === "string" &&
    typeof user?.login === "string"
    ? record
    : undefined;
}

function threadBody(
  bodies: ReadonlyMap<unknown, string>,
  comment: Record<string, unknown>,
): string {
  return bodies.get(comment.in_reply_to_id) ?? String(comment.body);
}

async function reviewCommentPage(
  transport: GitHubTransport,
  repository: string,
  pullRequestNumber: number,
  page: number,
): Promise<Record<string, unknown>[]> {
  const response = await transport({
    method: "GET",
    path: `/repos/${repository}/pulls/${pullRequestNumber}/comments?per_page=100&page=${page}`,
  });
  return Array.isArray(response)
    ? response.map(reviewComment).filter((comment) => comment !== undefined)
    : [];
}

export async function listFindingDiscussionComments(
  transport: GitHubTransport,
  repository: string,
  pullRequestNumber: number,
): Promise<FindingDiscussionComment[]> {
  const comments: Record<string, unknown>[] = [];
  for (let page = 1; ; page += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const next = await reviewCommentPage(transport, repository, pullRequestNumber, page);
    comments.push(...next);
    if (next.length < 100) break;
  }
  const bodies = new Map(comments.map((comment) => [comment.id, String(comment.body)]));
  return comments.map((comment) => ({
    id: Number(comment.id),
    actor: String((comment.user as Record<string, unknown>).login),
    body: String(comment.body),
    createdAt: String(comment.created_at),
    threadBody: threadBody(bodies, comment),
    source: "pull_request_review_thread",
  }));
}
