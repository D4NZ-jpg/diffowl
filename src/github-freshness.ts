import {
  FINDING_COMMENT_MARKER,
  SUPERSEDED_FINDING_MARKER,
  supersededFindingBody,
} from "./github-presentation.js";
import type { GitHubTransport, PublicationTarget } from "./github-publication.js";

const PAGE_SIZE = 100;
const REVIEW_CHECK_NAME = "Review OWL";

interface BotComment {
  id: number;
  body?: string;
  user?: { login?: string };
}
interface CheckRun {
  id: number;
}

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} was invalid.`);
  }
  return value as Record<string, unknown>;
}
function numericId(value: unknown, context: string): number {
  const id = record(value, context).id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error(`${context} had no id.`);
  return id;
}
function parseBotComments(value: unknown, context: string): BotComment[] {
  if (!Array.isArray(value)) throw new Error(`${context} was invalid.`);
  return value.map((item) => {
    const comment = record(item, context);
    const user =
      typeof comment.user === "object" && comment.user !== null
        ? (comment.user as { login?: string })
        : undefined;
    return {
      id: numericId(comment, context),
      ...(typeof comment.body === "string" ? { body: comment.body } : {}),
      ...(user === undefined ? {} : { user }),
    };
  });
}
function parseCheckRuns(value: unknown): CheckRun[] {
  const runs = record(value, "GitHub check-runs response").check_runs;
  if (!Array.isArray(runs)) throw new Error("GitHub check-runs response was invalid.");
  return runs.map((item) => ({ id: numericId(item, "GitHub check-run item") }));
}
async function pages<T>(load: (page: number) => Promise<T[]>): Promise<T[]> {
  const result: T[] = [];
  let page = 1;
  let batch = await load(page);
  while (batch.length === PAGE_SIZE) {
    result.push(...batch);
    page += 1;
    // oxlint-disable-next-line no-await-in-loop
    batch = await load(page);
  }
  return [...result, ...batch];
}

export async function staleFindingCommentIds(
  request: GitHubTransport,
  target: PublicationTarget,
): Promise<number[]> {
  const comments = await pages((page) =>
    request({
      method: "GET",
      path: `/repos/${target.repository}/pulls/${target.pullRequestNumber}/comments?per_page=${PAGE_SIZE}&page=${page}`,
    }).then((response) => parseBotComments(response, "GitHub pull-request comments response")),
  );
  return comments
    .filter(
      (comment) =>
        comment.user?.login === "github-actions[bot]" &&
        comment.body?.includes(FINDING_COMMENT_MARKER) === true &&
        !comment.body.includes(SUPERSEDED_FINDING_MARKER),
    )
    .map((comment) => comment.id);
}

export async function supersedeStaleFindingComments(
  request: GitHubTransport,
  target: PublicationTarget,
  commentIds: number[],
  currentSummaryCommentId: number,
): Promise<void> {
  await Promise.all(
    commentIds.map((commentId) =>
      request({
        method: "PATCH",
        path: `/repos/${target.repository}/pulls/comments/${commentId}`,
        body: { body: supersededFindingBody(currentSummaryCommentId) },
      }),
    ),
  );
}

export async function supersedeStaleCheckRuns(
  request: GitHubTransport,
  target: PublicationTarget,
  currentCheckRunId: number,
): Promise<void> {
  const checkName = encodeURIComponent(REVIEW_CHECK_NAME);
  const runs = await pages((page) =>
    request({
      method: "GET",
      path: `/repos/${target.repository}/commits/${target.headSha}/check-runs?check_name=${checkName}&per_page=${PAGE_SIZE}&page=${page}`,
    }).then(parseCheckRuns),
  );
  await Promise.all(
    runs
      .filter((run) => run.id !== currentCheckRunId)
      .map((run) =>
        request({
          method: "PATCH",
          path: `/repos/${target.repository}/check-runs/${run.id}`,
          body: {
            name: REVIEW_CHECK_NAME,
            status: "completed",
            conclusion: "neutral",
            output: {
              title: "Review OWL: superseded",
              summary:
                "This check run was superseded by a newer Review OWL publication on the same head SHA.",
              text: "Use the maintained Review OWL summary for the current human-facing state.",
            },
          },
        }),
      ),
  );
}
