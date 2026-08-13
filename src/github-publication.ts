import { randomUUID } from "node:crypto";

import {
  staleFindingCommentIds,
  supersedeStaleCheckRuns,
  supersedeStaleFindingComments,
} from "./github-freshness.js";
import type { MaterialFinding, ReviewOutcome } from "./review-engine.js";
import {
  checkConclusion,
  checkOutput,
  findingBody,
  isActiveFinding,
  materialFindings,
  summaryBody,
} from "./github-presentation.js";
import { validatePublicationOutcome } from "./github-publication-validation.js";
import { beginSummaryPublication, finalizeSummaryPublication } from "./github-summary.js";

const API_VERSION = "2022-11-28";
const MAX_ANNOTATIONS = 50;
const REVIEW_CHECK_NAME = "Review OWL";

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
export interface PublicationAuthorization {
  sourceRunVerified: boolean;
}
export interface PublicationReceipt {
  headSha: string;
  reviewId?: number;
  reviewUrl?: string;
  checkRunId: number;
  summaryCommentId: number;
  inlineCommentCount: number;
  annotationCount: number;
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
function annotation(finding: InlineFinding) {
  return {
    path: finding.location.path,
    start_line: finding.location.line,
    end_line: finding.location.line,
    annotation_level: "failure",
    title: `Review OWL: ${finding.lifecycleState}`,
    message: finding.summary,
    raw_details: `${finding.impact}\n\nVerification: ${finding.verificationState.type} — ${finding.verificationState.explanation}`,
  };
}

async function publishReview(
  request: GitHubTransport,
  target: PublicationTarget,
  findings: InlineFinding[],
): Promise<ReviewReceipt | undefined> {
  if (findings.length === 0) return undefined;
  const result = asRecord(
    await request({
      method: "POST",
      path: `/repos/${target.repository}/pulls/${target.pullRequestNumber}/reviews`,
      body: {
        commit_id: target.headSha,
        event: "COMMENT",
        body: "Review OWL found material Findings. Use the inline threads for discussion.",
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

async function publishCheck(
  request: GitHubTransport,
  target: PublicationTarget,
  outcome: ReviewOutcome,
  inline: InlineFinding[],
) {
  const annotations = inline.map(annotation).slice(0, MAX_ANNOTATIONS);
  const result = await request({
    method: "POST",
    path: `/repos/${target.repository}/check-runs`,
    body: {
      name: REVIEW_CHECK_NAME,
      head_sha: target.headSha,
      status: "completed",
      conclusion: checkConclusion(outcome),
      output: { ...checkOutput(outcome), annotations },
    },
  });
  return {
    id: numericId(result, "GitHub check-run response"),
    annotationCount: annotations.length,
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
  const runMarker = randomUUID();
  const publishingId = await beginSummaryPublication(request, target, runMarker);
  const staleFindingComments = await staleFindingCommentIds(request, target);
  const review = await publishReview(request, target, inline);
  const check = await publishCheck(request, target, validated, inline);
  await supersedeStaleCheckRuns(request, target, check.id);
  await assertCurrentHead(request, target);
  const summaryCommentId = await finalizeSummaryPublication(
    request,
    target,
    runMarker,
    publishingId,
    summaryBody(validated, unanchored, review?.htmlUrl),
  );
  await supersedeStaleFindingComments(request, target, staleFindingComments, summaryCommentId);
  return {
    headSha: target.headSha,
    ...(review === undefined ? {} : { reviewId: review.id }),
    ...(review?.htmlUrl === undefined ? {} : { reviewUrl: review.htmlUrl }),
    checkRunId: check.id,
    summaryCommentId,
    inlineCommentCount: inline.length,
    annotationCount: check.annotationCount,
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
