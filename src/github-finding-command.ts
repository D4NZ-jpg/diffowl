/* oxlint-disable max-lines */
import type { FindingCommandIo, FindingCommandReviewComment } from "./finding-command.js";
import type { FindingLifecycleState } from "./review-orchestration.js";
import type {
  GitHubTransport,
  PublicationResult,
  PublicationReceipt,
} from "./github-publication.js";
import {
  githubBodyHasMarker,
  githubMarkerExists,
  githubRecord as record,
  githubText as text,
} from "./github-response.js";
import { readReviewRequestPullRequest, workflowDispatchRequest } from "./github-review-request.js";

function reviewComment(value: unknown): FindingCommandReviewComment {
  const response = record(value, "GitHub pull-request review comment");
  const actor = record(response.user, "GitHub pull-request review comment author");
  if (!(typeof response.id === "number" || typeof response.id === "string")) {
    throw new Error("GitHub pull-request review comment returned an invalid response.");
  }
  const inReplyToId = response.in_reply_to_id;
  if (
    inReplyToId !== undefined &&
    !(typeof inReplyToId === "number" || typeof inReplyToId === "string")
  ) {
    throw new Error("GitHub pull-request review comment returned an invalid response.");
  }
  return {
    id: String(response.id),
    actor: text(actor.login, "GitHub pull-request review comment author"),
    body: text(response.body, "GitHub pull-request review comment"),
    createdAt: text(response.created_at, "GitHub pull-request review comment"),
    isBot: actor.type === "Bot",
    ...(inReplyToId === undefined ? {} : { inReplyToId: String(inReplyToId) }),
  };
}

function markerExists(
  transport: GitHubTransport,
  repository: string,
  pullRequestNumber: number,
  marker: string,
): Promise<boolean> {
  return githubMarkerExists(
    marker,
    (page) =>
      transport({
        method: "GET",
        path: `/repos/${repository}/pulls/${pullRequestNumber}/comments?per_page=100&page=${page}`,
      }),
    "GitHub pull-request review comments",
  );
}

export interface FindingReplacementTarget {
  fingerprint: string;
  headSha: string;
  path: string;
  line: number;
  body: string;
}

export interface FindingDiscussionPublicationUpdate {
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  rootCommentId: string;
  lifecycleState: FindingLifecycleState;
  body: string;
  effectMarker: string;
  replacement?: FindingReplacementTarget | undefined;
}

export interface FindingDiscussionPublicationReceipt extends PublicationReceipt {
  result: PublicationResult;
  rootCommentId: string;
  replyCreated: boolean;
  threadResolved: boolean;
  replacementRootCommentId?: string | undefined;
}

function graphqlData(value: unknown, context: string): Record<string, unknown> {
  const response = record(value, context);
  if (Array.isArray(response.errors) && response.errors.length > 0) {
    throw new Error(`${context} returned GraphQL errors.`);
  }
  return record(response.data, `${context} data`);
}

async function currentHeadMatches(
  transport: GitHubTransport,
  update: FindingDiscussionPublicationUpdate,
): Promise<boolean> {
  const response = record(
    await transport({
      method: "GET",
      path: `/repos/${update.repository}/pulls/${update.pullRequestNumber}`,
    }),
    "GitHub pull request",
  );
  const head = record(response.head, "GitHub pull-request head");
  return head.sha === update.headSha;
}

function repositoryParts(repository: string): [string, string] {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((part) => part.length === 0)) {
    throw new Error("Repository must use owner/name form.");
  }
  return [parts[0]!, parts[1]!];
}

async function reviewThread(
  transport: GitHubTransport,
  update: FindingDiscussionPublicationUpdate,
): Promise<{ id: string; isResolved: boolean }> {
  const [owner, name] = repositoryParts(update.repository);
  const rootId = Number(update.rootCommentId);
  let cursor: string | undefined;
  for (let page = 1; page <= 10; page += 1) {
    // Review-thread reconciliation is bounded to 1,000 threads.
    const response = graphqlData(
      // oxlint-disable-next-line no-await-in-loop
      await transport({
        method: "POST",
        path: "/graphql",
        body: {
          query:
            "query DiffowlFindingThread($owner: String!, $name: String!, $number: Int!, $cursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $cursor) { nodes { id isResolved comments(first: 100) { nodes { databaseId } } } pageInfo { hasNextPage endCursor } } } } }",
          variables: { owner, name, number: update.pullRequestNumber, cursor: cursor ?? null },
        },
      }),
      "GitHub review-thread query",
    );
    const repositoryNode = record(response.repository, "GitHub review-thread repository");
    const pullRequest = record(repositoryNode.pullRequest, "GitHub review-thread pull request");
    const threads = record(pullRequest.reviewThreads, "GitHub review threads");
    if (!Array.isArray(threads.nodes)) {
      throw new Error("GitHub review threads returned an invalid response.");
    }
    for (const value of threads.nodes) {
      const thread = record(value, "GitHub review thread");
      const comments = record(thread.comments, "GitHub review-thread comments");
      if (
        Array.isArray(comments.nodes) &&
        comments.nodes.some(
          (comment) => record(comment, "GitHub review-thread comment").databaseId === rootId,
        )
      ) {
        return {
          id: text(thread.id, "GitHub review thread"),
          isResolved: thread.isResolved === true,
        };
      }
    }
    const pageInfo = record(threads.pageInfo, "GitHub review-thread page info");
    if (pageInfo.hasNextPage === false) {
      throw new Error("Unable to resolve the durable Finding discussion thread.");
    }
    if (pageInfo.hasNextPage !== true || typeof pageInfo.endCursor !== "string") {
      throw new Error("GitHub review-thread page info returned an invalid response.");
    }
    cursor = pageInfo.endCursor;
  }
  throw new Error("Unable to reconcile the Finding discussion within 1,000 review threads.");
}

function receipt(
  update: FindingDiscussionPublicationUpdate,
  values: Partial<FindingDiscussionPublicationReceipt>,
): FindingDiscussionPublicationReceipt {
  return {
    result: "complete",
    headSha: update.headSha,
    rootCommentId: update.rootCommentId,
    replyCreated: false,
    threadResolved: false,
    inlineCommentCount: 0,
    unanchoredFindingCount: 0,
    ...values,
  };
}

async function updateThreadDisposition(
  transport: GitHubTransport,
  threadId: string,
  terminal: boolean,
): Promise<void> {
  const mutation = terminal ? "resolveReviewThread" : "unresolveReviewThread";
  const data = graphqlData(
    await transport({
      method: "POST",
      path: "/graphql",
      body: {
        query: terminal
          ? "mutation DiffowlResolveFinding($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }"
          : "mutation DiffowlReopenFinding($threadId: ID!) { unresolveReviewThread(input: {threadId: $threadId}) { thread { id isResolved } } }",
        variables: { threadId },
      },
    }),
    "GitHub review-thread disposition",
  );
  const payload = record(data[mutation], "GitHub review-thread disposition result");
  const thread = record(payload.thread, "GitHub review-thread disposition thread");
  if (thread.id !== threadId || thread.isResolved !== terminal) {
    throw new Error("GitHub review-thread disposition returned an unexpected state.");
  }
}

function cannotContinue(error: unknown): boolean {
  return error instanceof Error && /failed \((?:404|409|422)\)/u.test(error.message);
}

function replacementMarker(update: FindingDiscussionPublicationUpdate): string {
  const replacement = update.replacement!;
  return `<!-- diffowl:finding-replacement:v1 fingerprint=${replacement.fingerprint} original=${update.rootCommentId} head=${replacement.headSha} -->`;
}

async function existingReplacementId(
  transport: GitHubTransport,
  update: FindingDiscussionPublicationUpdate,
  marker: string,
): Promise<string | undefined> {
  for (let page = 1; page <= 10; page += 1) {
    // Replacement reconciliation is bounded to 1,000 review comments.
    // oxlint-disable-next-line no-await-in-loop
    const response = await transport({
      method: "GET",
      path: `/repos/${update.repository}/pulls/${update.pullRequestNumber}/comments?per_page=100&page=${page}`,
    });
    if (!Array.isArray(response)) {
      throw new Error("GitHub pull-request review comments returned an invalid response.");
    }
    const existing = response.find((comment) => githubBodyHasMarker(comment, marker));
    if (existing !== undefined) {
      const id = record(existing, "GitHub replacement review comment").id;
      if (typeof id !== "number" && typeof id !== "string") {
        throw new Error("GitHub replacement review comment returned an invalid response.");
      }
      return String(id);
    }
    if (response.length < 100) return undefined;
  }
  throw new Error("Unable to reconcile a Finding replacement within 1,000 comments.");
}

async function createReplacement(
  transport: GitHubTransport,
  update: FindingDiscussionPublicationUpdate,
): Promise<string> {
  const replacement = update.replacement!;
  const marker = replacementMarker(update);
  const existing = await existingReplacementId(transport, update, marker);
  if (existing !== undefined) return existing;
  const originalUrl = `https://github.com/${update.repository}/pull/${update.pullRequestNumber}#discussion_r${update.rootCommentId}`;
  const response = record(
    await transport({
      method: "POST",
      path: `/repos/${update.repository}/pulls/${update.pullRequestNumber}/comments`,
      body: {
        commit_id: replacement.headSha,
        path: replacement.path,
        line: replacement.line,
        side: "RIGHT",
        body: `${replacement.body}\n\n${marker}\nContinues the original Finding discussion: ${originalUrl}`,
      },
    }),
    "GitHub replacement review comment",
  );
  if (typeof response.id !== "number" && typeof response.id !== "string") {
    throw new Error("GitHub replacement review comment returned an invalid response.");
  }
  return String(response.id);
}

// oxlint-disable-next-line complexity, max-lines-per-function
export async function publishFindingDiscussionUpdate(
  transport: GitHubTransport,
  update: FindingDiscussionPublicationUpdate,
): Promise<FindingDiscussionPublicationReceipt> {
  let replyCreated = await markerExists(
    transport,
    update.repository,
    update.pullRequestNumber,
    update.effectMarker,
  );
  try {
    if (!(await currentHeadMatches(transport, update))) {
      return receipt(update, {
        result: replyCreated ? "incomplete" : "refused",
        replyCreated,
        reason: "The pull-request head changed before Finding discussion publication.",
      });
    }
  } catch (error) {
    return receipt(update, {
      result: replyCreated ? "incomplete" : "refused",
      replyCreated,
      reason: error instanceof Error ? error.message : "Finding publication freshness failed.",
    });
  }
  if (!replyCreated) {
    try {
      await transport({
        method: "POST",
        path: `/repos/${update.repository}/pulls/${update.pullRequestNumber}/comments/${update.rootCommentId}/replies`,
        body: { body: `${update.body}\n\n${update.effectMarker}` },
      });
      replyCreated = true;
    } catch (error) {
      if (update.replacement !== undefined && cannotContinue(error)) {
        try {
          const replacementRootCommentId = await createReplacement(transport, update);
          const fresh = await currentHeadMatches(transport, update);
          return receipt(update, {
            ...(fresh ? {} : { result: "incomplete" as const }),
            replacementRootCommentId,
            ...(!fresh
              ? { reason: "The pull-request head changed after Finding replacement publication." }
              : {}),
          });
        } catch (replacementError) {
          return receipt(update, {
            result: "incomplete",
            reason:
              replacementError instanceof Error
                ? replacementError.message
                : "Finding replacement publication failed.",
          });
        }
      }
      return receipt(update, {
        result: "incomplete",
        reason: error instanceof Error ? error.message : "Finding discussion reply failed.",
      });
    }
  }
  let thread: Awaited<ReturnType<typeof reviewThread>>;
  try {
    thread = await reviewThread(transport, update);
  } catch (error) {
    return receipt(update, {
      result: "incomplete",
      replyCreated,
      reason: error instanceof Error ? error.message : "Finding thread lookup failed.",
    });
  }
  const terminal = ["resolved", "rebutted", "suppressed", "obsolete"].includes(
    update.lifecycleState,
  );
  try {
    if (terminal !== thread.isResolved) {
      if (!(await currentHeadMatches(transport, update))) {
        return receipt(update, {
          result: "incomplete",
          replyCreated,
          threadResolved: thread.isResolved,
          reason: "The pull-request head changed before Finding thread disposition.",
        });
      }
      await updateThreadDisposition(transport, thread.id, terminal);
    }
    if (!(await currentHeadMatches(transport, update))) {
      return receipt(update, {
        result: "incomplete",
        replyCreated,
        threadResolved: terminal,
        reason: "The pull-request head changed after Finding discussion publication.",
      });
    }
    return receipt(update, { replyCreated, threadResolved: terminal });
  } catch (error) {
    return receipt(update, {
      result: "incomplete",
      replyCreated,
      threadResolved: thread.isResolved,
      reason: error instanceof Error ? error.message : "Finding thread disposition failed.",
    });
  }
}

export interface GitHubFindingCommandIoOptions {
  repository: string;
  pullRequestNumber: number;
  workflow: string;
  readPolicy(revision: string): Promise<string | undefined>;
}

// oxlint-disable-next-line max-lines-per-function
export function createGitHubFindingCommandIo(
  transport: GitHubTransport,
  options: GitHubFindingCommandIoOptions,
): FindingCommandIo {
  return {
    readPullRequest: (repository, pullRequestNumber) =>
      readReviewRequestPullRequest(transport, repository, pullRequestNumber),
    readPolicy: options.readPolicy,
    readReviewComment: async (repository, commentId) =>
      reviewComment(
        await transport({
          method: "GET",
          path: `/repos/${repository}/pulls/comments/${encodeURIComponent(commentId)}`,
        }),
      ),
    addEyes: async (eventId) => {
      await transport({
        method: "POST",
        path: `/repos/${options.repository}/pulls/comments/${eventId}/reactions`,
        body: { content: "eyes" },
      });
    },
    replyOnce: async (eventId, rootCommentId, message) => {
      if (rootCommentId === undefined) return;
      const marker = `<!-- diffowl-finding-command:${eventId}:refusal -->`;
      if (await markerExists(transport, options.repository, options.pullRequestNumber, marker)) {
        return;
      }
      await transport({
        method: "POST",
        path: `/repos/${options.repository}/pulls/${options.pullRequestNumber}/comments/${rootCommentId}/replies`,
        body: { body: `${message}\n\n${marker}` },
      });
    },
    dispatchReview: async (request) => {
      await transport(workflowDispatchRequest(request, options.workflow));
    },
  };
}
