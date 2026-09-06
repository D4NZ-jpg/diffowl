import type { GitHubTransport } from "./github-publication.js";
import {
  githubMarkerExists,
  githubRecord as record,
  githubText as text,
} from "./github-response.js";
import type {
  RepositoryPermission,
  ReviewDispatch,
  ReviewRequestIo,
  ReviewRequestPullRequest,
} from "./review-request.js";

export async function readReviewRequestPullRequest(
  transport: GitHubTransport,
  repository: string,
  pullRequestNumber: number,
): Promise<ReviewRequestPullRequest> {
  const response = record(
    await transport({ method: "GET", path: `/repos/${repository}/pulls/${pullRequestNumber}` }),
    "GitHub pull request",
  );
  const user = record(response.user, "GitHub pull-request author");
  const base = record(response.base, "GitHub pull-request base");
  const head = record(response.head, "GitHub pull-request head");
  const baseRepository = record(base.repo, "GitHub pull-request base repository");
  const headRepository = record(head.repo, "GitHub pull-request head repository");
  if (!Number.isInteger(response.number) || response.number !== pullRequestNumber) {
    throw new Error("GitHub pull request returned an invalid response.");
  }
  return {
    number: pullRequestNumber,
    author: text(user.login, "GitHub pull-request author"),
    baseSha: text(base.sha, "GitHub pull-request base"),
    headSha: text(head.sha, "GitHub pull-request head"),
    baseRepository: text(baseRepository.full_name, "GitHub pull-request base repository"),
    headRepository: text(headRepository.full_name, "GitHub pull-request head repository"),
  };
}

export async function readRepositoryPermission(
  transport: GitHubTransport,
  repository: string,
  actor: string,
): Promise<RepositoryPermission> {
  let value: unknown;
  try {
    value = await transport({
      method: "GET",
      path: `/repos/${repository}/collaborators/${encodeURIComponent(actor)}/permission`,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("failed (404)")) return "none";
    throw error;
  }
  const response = record(value, "GitHub collaborator permission");
  const permission = response.permission;
  return permission === "read" ||
    permission === "triage" ||
    permission === "write" ||
    permission === "maintain" ||
    permission === "admin"
    ? permission
    : "none";
}

function refusalExists(
  transport: GitHubTransport,
  options: GitHubReviewRequestIoOptions,
  marker: string,
): Promise<boolean> {
  return githubMarkerExists(
    marker,
    (page) =>
      transport({
        method: "GET",
        path: `/repos/${options.repository}/issues/${options.pullRequestNumber}/comments?per_page=100&sort=created&direction=desc&page=${page}`,
      }),
    "GitHub issue comments",
  );
}

export function workflowDispatchRequest(
  request: ReviewDispatch,
  workflow: string,
): { method: "POST"; path: string; body: unknown } {
  const findingCommand = request.command === "recheck" || request.command === "reassess";
  return {
    method: "POST",
    path: `/repos/${request.repository}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    body: {
      ref: request.ref,
      inputs: {
        repository: request.repository,
        "pull-request-number": String(request.pullRequestNumber),
        "base-sha": request.baseSha,
        "head-sha": request.headSha,
        "head-repository": request.headRepository,
        "review-request-event-id": request.eventId,
        ...(findingCommand ? { "command-work-type": request.workType ?? "full_review" } : {}),
        ...(request.findingFingerprint === undefined
          ? {}
          : { "finding-fingerprint": request.findingFingerprint }),
        ...(request.findingContext === undefined
          ? {}
          : { "finding-context": request.findingContext }),
        ...(request.rootCommentId === undefined
          ? {}
          : { "finding-root-comment-id": request.rootCommentId }),
      },
    },
  };
}

export interface GitHubReviewRequestIoOptions {
  repository: string;
  pullRequestNumber: number;
  workflow: string;
  readPolicy(revision: string): Promise<string | undefined>;
}

export function createGitHubReviewRequestIo(
  transport: GitHubTransport,
  options: GitHubReviewRequestIoOptions,
): ReviewRequestIo {
  return {
    readPullRequest: (repository, pullRequestNumber) =>
      readReviewRequestPullRequest(transport, repository, pullRequestNumber),
    readPermission: (repository, actor) => readRepositoryPermission(transport, repository, actor),
    readPolicy: options.readPolicy,
    addEyes: async (eventId) => {
      await transport({
        method: "POST",
        path: `/repos/${options.repository}/issues/comments/${eventId}/reactions`,
        body: { content: "eyes" },
      });
    },
    replyOnce: async (eventId, message) => {
      const marker = `<!-- diffowl-review-request:${eventId}:refusal -->`;
      if (await refusalExists(transport, options, marker)) return;
      await transport({
        method: "POST",
        path: `/repos/${options.repository}/issues/${options.pullRequestNumber}/comments`,
        body: { body: `${message}\n\n${marker}` },
      });
    },
    dispatchReview: async (request) => {
      await transport(workflowDispatchRequest(request, options.workflow));
    },
  };
}
