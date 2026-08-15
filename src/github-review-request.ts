import type { GitHubTransport } from "./github-publication.js";
import type {
  RepositoryPermission,
  ReviewRequestIo,
  ReviewRequestPullRequest,
} from "./review-request.js";

function record(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} returned an invalid response.`);
  }
  return value;
}

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

async function readPermission(
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

function commentHasMarker(comment: unknown, marker: string): boolean {
  return (
    typeof comment === "object" &&
    comment !== null &&
    typeof (comment as Record<string, unknown>).body === "string" &&
    ((comment as Record<string, unknown>).body as string).includes(marker)
  );
}

async function refusalExists(
  transport: GitHubTransport,
  options: GitHubReviewRequestIoOptions,
  marker: string,
): Promise<boolean> {
  for (let page = 1; page <= 10; page += 1) {
    // oxlint-disable-next-line no-await-in-loop
    const response = await transport({
      method: "GET",
      path: `/repos/${options.repository}/issues/${options.pullRequestNumber}/comments?per_page=100&sort=created&direction=desc&page=${page}`,
    });
    if (!Array.isArray(response)) {
      throw new Error("GitHub issue comments returned an invalid response.");
    }
    if (response.some((comment) => commentHasMarker(comment, marker))) return true;
    if (response.length < 100) return false;
  }
  throw new Error("Unable to reconcile a Review-request refusal within 1,000 comments.");
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
    readPermission: (repository, actor) => readPermission(transport, repository, actor),
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
      await transport({
        method: "POST",
        path: `/repos/${request.repository}/actions/workflows/${encodeURIComponent(options.workflow)}/dispatches`,
        body: {
          ref: request.ref,
          inputs: {
            repository: request.repository,
            "pull-request-number": String(request.pullRequestNumber),
            "base-sha": request.baseSha,
            "head-sha": request.headSha,
            "review-request-event-id": request.eventId,
          },
        },
      });
    },
  };
}
