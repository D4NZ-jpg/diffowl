import {
  PUBLISHING_SUMMARY_MARKER,
  SUMMARY_MARKER,
  publishingSummaryBody,
  supersededSummaryBody,
} from "./github-presentation.js";
import type { GitHubRequest, GitHubTransport, PublicationTarget } from "./github-publication.js";

const PAGE_SIZE = 100;
const BOT_LOGIN = "github-actions[bot]";
interface IssueCommentResponse {
  id: number;
  body?: string;
  user?: { login?: string };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("GitHub summary response was invalid.");
  }
  return value as Record<string, unknown>;
}
function numericId(value: unknown): number {
  const id = record(value).id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) {
    throw new Error("GitHub summary response had no id.");
  }
  return id;
}
function parseComments(value: unknown): IssueCommentResponse[] {
  if (!Array.isArray(value)) throw new Error("GitHub issue comments response was invalid.");
  return value.map((item) => {
    const comment = record(item);
    if (typeof comment.id !== "number") throw new Error("GitHub issue comment had no id.");
    const user =
      typeof comment.user === "object" && comment.user !== null
        ? (comment.user as { login?: string })
        : undefined;
    return {
      id: comment.id,
      ...(typeof comment.body === "string" ? { body: comment.body } : {}),
      ...(user === undefined ? {} : { user }),
    };
  });
}
async function page(
  request: GitHubTransport,
  target: PublicationTarget,
  number: number,
): Promise<IssueCommentResponse[]> {
  return parseComments(
    await request({
      method: "GET",
      path: `/repos/${target.repository}/issues/${target.pullRequestNumber}/comments?per_page=${PAGE_SIZE}&page=${number}`,
    }),
  );
}
async function comments(
  request: GitHubTransport,
  target: PublicationTarget,
): Promise<IssueCommentResponse[]> {
  const result: IssueCommentResponse[] = [];
  let number = 1;
  let batch = await page(request, target, number);
  while (batch.length === PAGE_SIZE) {
    result.push(...batch);
    number += 1;
    // oxlint-disable-next-line no-await-in-loop
    batch = await page(request, target, number);
  }
  return [...result, ...batch];
}
function adapterSummary(comment: IssueCommentResponse): boolean {
  return (
    comment.user?.login === BOT_LOGIN &&
    (comment.body?.includes(SUMMARY_MARKER) === true ||
      comment.body?.includes(PUBLISHING_SUMMARY_MARKER) === true)
  );
}
async function patch(
  request: GitHubTransport,
  target: PublicationTarget,
  id: number,
  body: string,
): Promise<number> {
  const operation: GitHubRequest = {
    method: "PATCH",
    path: `/repos/${target.repository}/issues/comments/${id}`,
    body: { body },
  };
  return numericId(await request(operation));
}

export async function beginSummaryPublication(
  request: GitHubTransport,
  target: PublicationTarget,
  runMarker: string,
): Promise<number> {
  const matches = (await comments(request, target)).filter(adapterSummary);
  await Promise.all(
    matches.map((comment) => patch(request, target, comment.id, supersededSummaryBody())),
  );
  return numericId(
    await request({
      method: "POST",
      path: `/repos/${target.repository}/issues/${target.pullRequestNumber}/comments`,
      body: { body: publishingSummaryBody(runMarker, target.headSha) },
    }),
  );
}

export async function finalizeSummaryPublication(
  request: GitHubTransport,
  target: PublicationTarget,
  runMarker: string,
  publishingId: number,
  body: string,
): Promise<number> {
  const publishingMarker = `${PUBLISHING_SUMMARY_MARKER} run=${runMarker} `;
  const matches = (await comments(request, target)).filter(adapterSummary);
  const own = matches.find(
    (comment) => comment.id === publishingId && comment.body?.includes(publishingMarker),
  );
  if (own === undefined) throw new Error("Review OWL publication lost its summary lease.");
  const competing = matches.filter((comment) => comment.id !== publishingId);
  if (competing.some((comment) => comment.id > publishingId)) {
    await patch(request, target, publishingId, supersededSummaryBody());
    throw new Error("Review OWL publication was superseded by a concurrent run.");
  }
  await Promise.all(
    competing.map((comment) =>
      patch(request, target, comment.id, supersededSummaryBody(publishingId)),
    ),
  );
  await patch(request, target, publishingId, body);
  const current = (await comments(request, target)).filter(
    (comment) => comment.user?.login === BOT_LOGIN && comment.body?.includes(SUMMARY_MARKER),
  );
  if (current.length !== 1 || current[0]?.id !== publishingId) {
    await patch(request, target, publishingId, supersededSummaryBody());
    throw new Error("Review OWL could not establish one authoritative summary.");
  }
  return publishingId;
}
