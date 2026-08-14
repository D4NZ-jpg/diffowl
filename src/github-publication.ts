import type { MaterialFinding } from "./review-engine.js";
import { findingBody, isActiveFinding, materialFindings } from "./github-presentation.js";
import { validatePublicationOutcome } from "./github-publication-validation.js";

const API_VERSION = "2022-11-28";

export class PublicationRefusalError extends Error {
  constructor(message = "Refusing to publish an invalid, oversized, or stale Review outcome.") {
    super(message);
    this.name = "PublicationRefusalError";
  }
}

export function isPublicationRefusal(error: unknown): boolean {
  return error instanceof PublicationRefusalError;
}

export interface GitHubRequest {
  method: "GET" | "POST" | "PATCH";
  path: string;
  body?: unknown;
}
export type GitHubTransport = (request: GitHubRequest) => Promise<unknown>;
export interface PublicationTarget {
  repository: string;
  pullRequestNumber: number;
  headSha: string;
  changedLines: ReadonlyArray<{ path: string; line: number }>;
}
export type PublicationSurface = "pull_request_review";
export const REQUIRED_PUBLICATION_SURFACES: readonly PublicationSurface[] = ["pull_request_review"];
export interface PublicationAuthorization {
  sourceRunVerified: boolean;
  surfaces: readonly PublicationSurface[];
}
export type PublicationResult = "complete" | "not_attempted" | "refused" | "incomplete";
export interface PublicationReceipt {
  result: PublicationResult;
  headSha: string;
  reviewId?: number;
  reviewUrl?: string;
  inlineCommentCount: number;
  unanchoredFindingCount: number;
}
interface ReviewReceipt {
  id: number;
  htmlUrl?: string;
}
type InlineFinding = MaterialFinding & { location: { path: string; line: number } };

function asRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${context} was invalid.`);
  return value as Record<string, unknown>;
}
function numericId(value: unknown, context: string): number {
  const id = asRecord(value, context).id;
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error(`${context} had no id.`);
  return id;
}
function currentHead(value: unknown): string {
  const head = asRecord(
    asRecord(value, "GitHub pull request response").head,
    "GitHub pull request head",
  );
  if (typeof head.sha !== "string") throw new Error("GitHub pull request head had no SHA.");
  return head.sha;
}
function changedLineKeys(target: PublicationTarget): Set<string> {
  return new Set(target.changedLines.map(({ path, line }) => `${path}\0${line}`));
}
function inlineFinding(finding: MaterialFinding, lines: Set<string>): finding is InlineFinding {
  return (
    finding.location.line !== undefined &&
    lines.has(`${finding.location.path}\0${finding.location.line}`)
  );
}
function reviewBody(unanchored: MaterialFinding[]): string {
  const lines = ["Review OWL found material Findings. Use these review threads for discussion."];
  if (unanchored.length > 0) {
    lines.push("", "### Findings without a current inline anchor");
    for (const finding of unanchored) {
      lines.push("", findingBody(finding));
    }
  }
  return lines.join("\n");
}

async function publishReview(
  request: GitHubTransport,
  target: PublicationTarget,
  findings: InlineFinding[],
  unanchored: MaterialFinding[],
): Promise<ReviewReceipt | undefined> {
  if (findings.length === 0 && unanchored.length === 0) return undefined;
  const result = asRecord(
    await request({
      method: "POST",
      path: `/repos/${target.repository}/pulls/${target.pullRequestNumber}/reviews`,
      body: {
        commit_id: target.headSha,
        event: "COMMENT",
        body: reviewBody(unanchored),
        comments: findings.map((finding) => ({
          path: finding.location.path,
          line: finding.location.line,
          side: "RIGHT",
          body: findingBody(finding),
        })),
      },
    }),
    "GitHub review response",
  );
  return {
    id: numericId(result, "GitHub review response"),
    ...(typeof result.html_url === "string" ? { htmlUrl: result.html_url } : {}),
  };
}

async function assertCurrentHead(
  request: GitHubTransport,
  target: PublicationTarget,
): Promise<void> {
  const response = await request({
    method: "GET",
    path: `/repos/${target.repository}/pulls/${target.pullRequestNumber}`,
  });
  if (currentHead(response) !== target.headSha) {
    throw new Error("Refusing to publish an invalid, oversized, or stale Review outcome.");
  }
}

export async function publishReviewOutcome(
  request: GitHubTransport,
  target: PublicationTarget,
  outcome: unknown,
  authorization?: PublicationAuthorization,
): Promise<PublicationReceipt> {
  const pullRequest = await request({
    method: "GET",
    path: `/repos/${target.repository}/pulls/${target.pullRequestNumber}`,
  });
  const validated = validatePublicationOutcome(
    outcome,
    target,
    authorization,
    currentHead(pullRequest) === target.headSha,
  );
  const active = materialFindings(validated).filter(isActiveFinding);
  const lines = changedLineKeys(target);
  const inline = active.filter((finding) => inlineFinding(finding, lines));
  const unanchored = active.filter((finding) => !inlineFinding(finding, lines));
  await assertCurrentHead(request, target);
  const review = await publishReview(request, target, inline, unanchored);
  await assertCurrentHead(request, target);
  return {
    result: "complete",
    headSha: target.headSha,
    ...(review === undefined ? {} : { reviewId: review.id }),
    ...(review?.htmlUrl === undefined ? {} : { reviewUrl: review.htmlUrl }),
    inlineCommentCount: inline.length,
    unanchoredFindingCount: unanchored.length,
  };
}

export function createGitHubTransport(token: string, apiUrl = "https://api.github.com") {
  return async (request: GitHubRequest): Promise<unknown> => {
    const response = await fetch(`${apiUrl}${request.path}`, {
      method: request.method,
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "x-github-api-version": API_VERSION,
        ...(request.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) }),
    });
    if (!response.ok)
      throw new Error(`GitHub API ${request.method} ${request.path} failed (${response.status}).`);
    return response.json();
  };
}
