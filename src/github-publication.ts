/* oxlint-disable max-lines */
import { canonicalJsonHash } from "./canonical-json.js";
import {
  publishFindingDiscussionUpdate,
  type FindingDiscussionPublicationReceipt,
  type FindingDiscussionPublicationUpdate,
} from "./github-finding-command.js";
import type { MaterialFinding, ReviewOutcome } from "./review-engine.js";
import {
  GITHUB_BODY_LIMIT,
  findingBody,
  isActiveFinding,
  unanchoredFindingBody,
  materialFindings,
} from "./github-presentation.js";
import { validatePublicationOutcome } from "./github-publication-validation.js";

const API_VERSION = "2022-11-28";

export class PublicationRefusalError extends Error {
  constructor(message = "Refusing to publish an invalid, oversized, or stale Review outcome.") {
    super(message);
    this.name = "PublicationRefusalError";
  }
}

export class IncompletePublicationError extends Error {
  constructor(
    message: string,
    readonly confirmedEffects: PublicationReceipt,
  ) {
    super(message);
    this.name = "IncompletePublicationError";
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
  claimAuthority?: () => Promise<void>;
  reserveEffect?: (effectId: string) => Promise<"create" | "reconcile">;
}
export type PublicationResult = "complete" | "not_attempted" | "refused" | "incomplete";
export interface PublicationReceipt {
  result: PublicationResult;
  headSha: string;
  reviewId?: number;
  reviewUrl?: string;
  reviewCreated?: boolean;
  reviewEffectId?: string;
  findingDiscussionEffects?: FindingDiscussionPublicationReceipt[] | undefined;
  inlineCommentCount: number;
  unanchoredFindingCount: number;
  reason?: string;
}
interface ReviewReceipt {
  id: number;
  effectId: string;
  htmlUrl?: string;
}
type InlineFinding = MaterialFinding & { location: { path: string; line: number } };
interface ExistingFindingRoot {
  fingerprint: string;
  rootCommentId: string;
}

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
function findingFingerprintFromBody(body: unknown): string | undefined {
  if (typeof body !== "string") return undefined;
  return /<!-- diffowl:finding:v1 fingerprint=(sha256:[\da-f]{64}) -->/iu
    .exec(body)?.[1]
    ?.toLowerCase();
}

async function existingFindingRoots(
  request: GitHubTransport,
  target: PublicationTarget,
): Promise<Map<string, ExistingFindingRoot>> {
  const roots = new Map<string, ExistingFindingRoot>();
  for (let page = 1; page <= 10; page += 1) {
    // Review-comment pagination is bounded by the first short page.
    // oxlint-disable-next-line no-await-in-loop
    const response = await request({
      method: "GET",
      path: `/repos/${target.repository}/pulls/${target.pullRequestNumber}/comments?per_page=100&page=${page}`,
    });
    if (!Array.isArray(response)) throw new Error("GitHub review comments response was invalid.");
    for (const value of response) {
      const comment = asRecord(value, "GitHub review comment response");
      if (comment.in_reply_to_id !== undefined) continue;
      const author = asRecord(comment.user, "GitHub review comment author");
      if (author.type !== "Bot" || author.login !== "github-actions[bot]") continue;
      const fingerprint = findingFingerprintFromBody(comment.body);
      if (fingerprint === undefined) continue;
      roots.set(fingerprint, {
        fingerprint,
        rootCommentId: String(numericId(comment, "GitHub review comment response")),
      });
    }
    if (response.length < 100) return roots;
  }
  throw new PublicationRefusalError(
    "Unable to reconcile Finding roots within 1,000 review comments.",
  );
}

// oxlint-disable-next-line complexity
function lifecycleUpdates(
  outcome: ReviewOutcome,
  roots: ReadonlyMap<string, ExistingFindingRoot>,
  target: PublicationTarget,
): FindingDiscussionPublicationUpdate[] {
  if (outcome.run === undefined) return [];
  const transitions = new Map(
    outcome.run.outcome.ledgerTransitions?.map((transition) => [
      transition.fingerprint,
      transition,
    ]),
  );
  const current = new Map(
    materialFindings(outcome).map((finding) => [finding.fingerprint.value, finding]),
  );
  const updates: FindingDiscussionPublicationUpdate[] = [];
  for (const [fingerprint, root] of roots) {
    const finding = current.get(fingerprint);
    const transition = transitions.get(fingerprint);
    const continuing = finding !== undefined && isActiveFinding(finding);
    if (!continuing && transition?.changed !== true) continue;
    const lifecycleState = transition?.lifecycleState ?? finding!.lifecycleState;
    const effectMarker = `<!-- diffowl:finding-update:v1 run=${outcome.run.runId} fingerprint=${fingerprint} root=${root.rootCommentId} -->`;
    updates.push({
      repository: target.repository,
      pullRequestNumber: target.pullRequestNumber,
      headSha: target.headSha,
      rootCommentId: root.rootCommentId,
      lifecycleState,
      body: [
        `Review OWL continued this Finding at \`${target.headSha}\`.`,
        "",
        `Disposition: **${lifecycleState}**.`,
        "The original claim, evidence, replies, reassessments, and patch history remain in this discussion.",
      ].join("\n"),
      effectMarker,
      ...(finding !== undefined && continuing && inlineFinding(finding, changedLineKeys(target))
        ? {
            replacement: {
              fingerprint,
              headSha: target.headSha,
              path: finding.location.path,
              line: finding.location.line,
              body: findingBody(finding),
            },
          }
        : {}),
    });
  }
  return updates;
}

function reviewBody(unanchored: MaterialFinding[]): string {
  const lines = ["Review OWL found material Findings. Use these review threads for discussion."];
  if (unanchored.length > 0) {
    lines.push("", "### Findings without a current inline anchor");
    for (const finding of unanchored) {
      lines.push("", unanchoredFindingBody(finding));
    }
  }
  return lines.join("\n");
}

function reviewEffectId(
  target: PublicationTarget,
  body: string,
  comments: ReadonlyArray<{ path: string; line: number; side: string; body: string }>,
): string {
  return canonicalJsonHash({
    version: 1,
    surface: "pull_request_review",
    headSha: target.headSha,
    body,
    comments: comments.map((comment) => ({ ...comment })),
  });
}

function reviewEffectMarker(effectId: string): string {
  return `<!-- diffowl-publication-effect:${effectId} -->`;
}

async function findPublishedReview(
  request: GitHubTransport,
  target: PublicationTarget,
  effectId: string,
  expectedBody: string,
): Promise<ReviewReceipt | undefined> {
  for (let page = 1; page <= 10; page += 1) {
    // GitHub review pagination is bounded by the first short page.
    // oxlint-disable-next-line no-await-in-loop
    const response = await request({
      method: "GET",
      path: `/repos/${target.repository}/pulls/${target.pullRequestNumber}/reviews?per_page=100&page=${page}`,
    });
    if (!Array.isArray(response)) throw new Error("GitHub reviews response was invalid.");
    for (const value of response) {
      const review = asRecord(value, "GitHub review response");
      const author = asRecord(review.user, "GitHub review author");
      if (
        author.type !== "Bot" ||
        author.login !== "github-actions[bot]" ||
        review.body !== expectedBody ||
        review.commit_id !== target.headSha
      ) {
        continue;
      }
      return {
        id: numericId(review, "GitHub review response"),
        effectId,
        ...(typeof review.html_url === "string" ? { htmlUrl: review.html_url } : {}),
      };
    }
    if (response.length < 100) return undefined;
  }
  throw new Error("Unable to reconcile a pull-request review within 1,000 reviews.");
}

// oxlint-disable-next-line complexity, max-lines-per-function
async function publishReview(
  request: GitHubTransport,
  target: PublicationTarget,
  findings: InlineFinding[],
  unanchored: MaterialFinding[],
  reserveEffect?: PublicationAuthorization["reserveEffect"],
): Promise<ReviewReceipt | undefined> {
  if (findings.length === 0 && unanchored.length === 0) return undefined;
  const visibleBody = reviewBody(unanchored);
  const comments = findings.map((finding) => ({
    path: finding.location.path,
    line: finding.location.line,
    side: "RIGHT",
    body: findingBody(finding),
  }));
  const effectId = reviewEffectId(target, visibleBody, comments);
  const body = `${reviewEffectMarker(effectId)}\n${visibleBody}`;
  if (
    Buffer.byteLength(body) > GITHUB_BODY_LIMIT ||
    comments.some((comment) => Buffer.byteLength(comment.body) > GITHUB_BODY_LIMIT)
  ) {
    throw new PublicationRefusalError();
  }
  const reservation = await reserveEffect?.(effectId);
  const existing = await findPublishedReview(request, target, effectId, body);
  if (existing !== undefined) return existing;
  if (reservation === "reconcile") {
    const message = "A reserved pull-request review is not yet visible for reconciliation.";
    throw new IncompletePublicationError(message, {
      result: "incomplete",
      headSha: target.headSha,
      reviewEffectId: effectId,
      inlineCommentCount: findings.length,
      unanchoredFindingCount: unanchored.length,
      reason: message,
    });
  }
  let response: unknown;
  try {
    response = await request({
      method: "POST",
      path: `/repos/${target.repository}/pulls/${target.pullRequestNumber}/reviews`,
      body: { commit_id: target.headSha, event: "COMMENT", body, comments },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub review request failed.";
    throw new IncompletePublicationError(message, {
      result: "incomplete",
      headSha: target.headSha,
      reviewEffectId: effectId,
      inlineCommentCount: findings.length,
      unanchoredFindingCount: unanchored.length,
      reason: message,
    });
  }
  try {
    const result = asRecord(response, "GitHub review response");
    return {
      id: numericId(result, "GitHub review response"),
      effectId,
      ...(typeof result.html_url === "string" ? { htmlUrl: result.html_url } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "GitHub review response was invalid.";
    throw new IncompletePublicationError(message, {
      result: "incomplete",
      headSha: target.headSha,
      reviewCreated: true,
      reviewEffectId: effectId,
      inlineCommentCount: findings.length,
      unanchoredFindingCount: unanchored.length,
      reason: message,
    });
  }
}

async function readCurrentHead(
  request: GitHubTransport,
  target: PublicationTarget,
): Promise<string> {
  try {
    return currentHead(
      await request({
        method: "GET",
        path: `/repos/${target.repository}/pulls/${target.pullRequestNumber}`,
      }),
    );
  } catch {
    throw new PublicationRefusalError();
  }
}

async function assertCurrentHead(
  request: GitHubTransport,
  target: PublicationTarget,
): Promise<void> {
  if ((await readCurrentHead(request, target)) !== target.headSha)
    throw new PublicationRefusalError();
}

// oxlint-disable-next-line complexity, max-lines-per-function
export async function publishReviewOutcome(
  request: GitHubTransport,
  target: PublicationTarget,
  outcome: unknown,
  authorization?: PublicationAuthorization,
): Promise<PublicationReceipt> {
  const validated = validatePublicationOutcome(
    outcome,
    target,
    authorization,
    (await readCurrentHead(request, target)) === target.headSha,
  );
  await authorization?.claimAuthority?.();
  const roots = await existingFindingRoots(request, target);
  const active = materialFindings(validated).filter(isActiveFinding);
  const lines = changedLineKeys(target);
  const inline = active.filter(
    (finding): finding is InlineFinding =>
      inlineFinding(finding, lines) && !roots.has(finding.fingerprint.value),
  );
  const unanchored = active.filter((finding) => !inlineFinding(finding, lines));
  await assertCurrentHead(request, target);
  const findingDiscussionEffects: FindingDiscussionPublicationReceipt[] = [];
  for (const update of lifecycleUpdates(validated, roots, target)) {
    // Finding discussion projections are bounded to persisted Findings.
    // oxlint-disable-next-line no-await-in-loop
    const discussion = await publishFindingDiscussionUpdate(request, update);
    findingDiscussionEffects.push(discussion);
    if (discussion.result !== "complete") {
      const reason = discussion.reason ?? "Finding discussion publication was incomplete.";
      throw new IncompletePublicationError(reason, {
        result: "incomplete",
        headSha: target.headSha,
        findingDiscussionEffects,
        inlineCommentCount: 0,
        unanchoredFindingCount: 0,
        reason,
      });
    }
  }
  let review: ReviewReceipt | undefined;
  try {
    review = await publishReview(request, target, inline, unanchored, authorization?.reserveEffect);
  } catch (error) {
    if (findingDiscussionEffects.length === 0) throw error;
    const message = error instanceof Error ? error.message : "GitHub publication failed.";
    const confirmed =
      error instanceof IncompletePublicationError
        ? error.confirmedEffects
        : {
            result: "incomplete" as const,
            headSha: target.headSha,
            inlineCommentCount: 0,
            unanchoredFindingCount: 0,
            reason: message,
          };
    throw new IncompletePublicationError(message, {
      ...confirmed,
      result: "incomplete",
      headSha: target.headSha,
      findingDiscussionEffects,
      reason: message,
    });
  }
  try {
    await assertCurrentHead(request, target);
  } catch (error) {
    if (review === undefined && findingDiscussionEffects.length === 0) throw error;
    const message = error instanceof Error ? error.message : "GitHub publication failed.";
    throw new IncompletePublicationError(message, {
      result: "incomplete",
      headSha: target.headSha,
      ...(review === undefined
        ? {}
        : {
            reviewId: review.id,
            reviewEffectId: review.effectId,
            ...(review.htmlUrl === undefined ? {} : { reviewUrl: review.htmlUrl }),
          }),
      ...(findingDiscussionEffects.length === 0 ? {} : { findingDiscussionEffects }),
      inlineCommentCount: inline.length,
      unanchoredFindingCount: unanchored.length,
      reason: message,
    });
  }
  return {
    result: "complete",
    headSha: target.headSha,
    ...(review === undefined ? {} : { reviewId: review.id, reviewEffectId: review.effectId }),
    ...(review?.htmlUrl === undefined ? {} : { reviewUrl: review.htmlUrl }),
    ...(findingDiscussionEffects.length === 0 ? {} : { findingDiscussionEffects }),
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
    return response.status === 204 ? undefined : response.json();
  };
}
