/* oxlint-disable max-lines */
import { describe, expect, it } from "vitest";

import {
  createGitHubTransport,
  type GitHubRequest,
  type GitHubTransport,
  publishReviewOutcome,
} from "../src/github-publication.js";
import {
  FINDING_COMMENT_MARKER,
  GITHUB_BODY_LIMIT,
  SUMMARY_MARKER,
  checkConclusion,
  checkOutput,
  findingBody,
  findingShortIdentity,
  summaryBody,
} from "../src/github-presentation.js";
import { parseGitHubReviewOutcome } from "../src/github-outcome-schema.js";
import { MAX_PUBLICATION_OUTCOME_BYTES } from "../src/github-publication-validation.js";
import type { FindingFingerprint, MaterialFinding, ReviewOutcome } from "../src/review-engine.js";
import { reviewedPullRequest, trustedSameRepoTrust } from "./review-fixtures.js";

const target = {
  repository: reviewedPullRequest.repository,
  pullRequestNumber: reviewedPullRequest.number,
  headSha: reviewedPullRequest.headSha,
  changedLines: [{ path: "src/handler.ts", line: 7 }],
};

const authorization = {
  sourceRunVerified: true,
  surfaces: ["pull_request_review"] as const,
};
type IssueCommentPage = Array<{
  id: number;
  body: string;
  user: { login: string };
}>;

const findingFingerprint: FindingFingerprint = {
  version: 1,
  algorithm: "diffowl-finding-v1",
  value: "finding-null-input",
  components: {},
};

function finding(line: number | null = 7): MaterialFinding {
  return {
    fingerprint: findingFingerprint,
    summary: "Null input crashes the request handler",
    location: { path: "src/handler.ts", ...(line === null ? {} : { line }) },
    impact: "A malformed request returns 500.",
    evidence: [
      {
        id: "repository-handler",
        type: "repository_file",
        path: "src/handler.ts",
        content: "input.value",
        truncated: false,
      },
    ],
    lifecycleState: "new",
    verificationState: {
      type: "verified",
      explanation: "The dereference is unguarded.",
      limitations: [],
    },
  };
}

// Exhaustive factory intentionally keeps all outcome fixtures beside their mapping assertion.
// oxlint-disable-next-line complexity, max-lines-per-function
function outcome(type: ReviewOutcome["type"]): ReviewOutcome {
  const base = { pullRequest: reviewedPullRequest, trust: trustedSameRepoTrust };
  const configured = {
    ...base,
    policy: {
      source: {
        type: "trusted_base_branch" as const,
        revision: reviewedPullRequest.baseSha,
        path: ".diffowl.json" as const,
      },
      effective: {
        version: 1 as const,
        scope: { includePaths: ["src/**"], excludePaths: [] },
        limits: { reviewTimeoutSeconds: 600, maxFindings: 25 },
        verification: { validationCommands: [] },
        roleProfiles: {
          reviewer: { provider: "openai", model: "gpt-5", credentialProfile: "default" },
          challenger: { provider: "openai", model: "gpt-5", credentialProfile: "default" },
          verifier: { provider: "openai", model: "gpt-5", credentialProfile: "default" },
        },
      },
    },
  };
  const completed = {
    ...configured,
    coverage: "completed_permitted" as const,
    advisorySuggestions: [],
    verification: {
      evidenceCatalog: [],
      validationAttempts: [],
      limitations: [],
      coverageGaps: [],
    },
    orchestrationPlan: { maxCandidateFindings: 25, steps: [] },
    executionArtifacts: [],
  };
  switch (type) {
    case "clean":
      return { ...completed, type, materialFindings: [] };
    case "findings":
      return { ...completed, type, materialFindings: [finding()] };
    case "policy_skip":
      return { type, reason: "not applicable", trust: trustedSameRepoTrust };
    case "unsupported_change":
      return { type, reason: "unsupported", trust: trustedSameRepoTrust };
    case "abstention":
      return {
        ...configured,
        type,
        reason: "insufficient evidence",
        materialFindings: [],
        advisorySuggestions: [],
        verification: completed.verification,
        executionArtifacts: [],
      };
    case "partial_coverage":
      return { ...configured, type, reason: "some paths skipped" };
    case "timeout":
      return { ...configured, type, timeoutSeconds: 600, executionArtifacts: [] };
    case "configuration_failure":
      return { ...base, type, reason: "invalid policy", policySource: configured.policy.source };
    case "provider_failure":
    case "budget_limit":
    case "resource_limit":
      return { ...configured, type, reason: `${type} reason`, executionArtifacts: [] };
    case "internal_failure":
      return { ...configured, type, reason: "unexpected" };
  }
}

// oxlint-disable-next-line max-lines-per-function
function fakeTransport(
  options: {
    existingSummary?: boolean;
    currentHead?: string;
    commentPages?: IssueCommentPage[];
    failPath?: string;
    currentHeads?: string[];
    reviewComments?: IssueCommentPage;
    checkRuns?: number[];
  } = {},
) {
  const requests: GitHubRequest[] = [];
  const comments: IssueCommentPage = options.existingSummary
    ? [{ id: 31, body: SUMMARY_MARKER, user: { login: "github-actions[bot]" } }]
    : [{ id: 30, body: SUMMARY_MARKER, user: { login: "someone-else" } }];
  const reviewComments: IssueCommentPage = options.reviewComments ?? [];
  const checkRuns = options.checkRuns ?? [];
  let seededPages = false;
  let headRead = 0;
  // oxlint-disable-next-line complexity
  const transport: GitHubTransport = async (request) => {
    requests.push(request);
    if (options.failPath !== undefined && request.path.endsWith(options.failPath)) {
      throw new Error("injected publication failure");
    }
    if (request.method === "GET" && /\/pulls\/\d+$/u.test(request.path)) {
      const head = options.currentHeads?.[headRead] ?? options.currentHead ?? target.headSha;
      headRead += 1;
      return { head: { sha: head } };
    }
    if (
      request.method === "GET" &&
      request.path.includes("/pulls/") &&
      request.path.includes("/comments")
    ) {
      const page = Number(new URL(request.path, "https://example.test").searchParams.get("page"));
      return reviewComments.slice((page - 1) * 100, page * 100);
    }
    if (request.method === "GET" && request.path.includes("/check-runs")) {
      return { check_runs: checkRuns.map((id) => ({ id })) };
    }
    if (request.method === "GET") {
      const page = Number(new URL(request.path, "https://example.test").searchParams.get("page"));
      if (options.commentPages !== undefined && !seededPages) {
        const configured = options.commentPages[page - 1] ?? [];
        if (configured.length < 100) {
          comments.splice(0, comments.length, ...options.commentPages.flat());
          seededPages = true;
        }
        return configured;
      }
      return comments.slice((page - 1) * 100, page * 100);
    }
    if (request.path.endsWith("/reviews")) return { id: 41 };
    if (request.path.endsWith("/check-runs")) return { id: 42 };
    const patchedReviewCommentId = /\/pulls\/comments\/(\d+)$/u.exec(request.path)?.[1];
    if (patchedReviewCommentId !== undefined) {
      const existing = reviewComments.find(
        (comment) => comment.id === Number(patchedReviewCommentId),
      );
      if (existing !== undefined) existing.body = (request.body as { body: string }).body;
      return { id: Number(patchedReviewCommentId) };
    }
    const patchedCheckRunId = /\/check-runs\/(\d+)$/u.exec(request.path)?.[1];
    if (patchedCheckRunId !== undefined) return { id: Number(patchedCheckRunId) };
    const patchedCommentId = /\/issues\/comments\/(\d+)$/u.exec(request.path)?.[1];
    if (patchedCommentId !== undefined) {
      const existing = comments.find((comment) => comment.id === Number(patchedCommentId));
      if (existing !== undefined) existing.body = (request.body as { body: string }).body;
      return { id: Number(patchedCommentId) };
    }
    comments.push({
      id: 43,
      body: (request.body as { body: string }).body,
      user: { login: "github-actions[bot]" },
    });
    return { id: 43 };
  };
  return { comments, requests, reviewComments, transport };
}

function providerFailureBeforeRunResult() {
  return {
    ...outcome("provider_failure"),
    executionArtifacts: [
      {
        role: "reviewer" as const,
        snapshot: {
          version: 1 as const,
          files: [{ path: "reviewer-failure.txt", data: "cmV2aWV3ZXI=" }],
        },
        events: [],
        files: [],
        sessionId: "",
        finishReason: "error",
      },
    ],
  };
}

function outcomeWithLargeEvidence(): ReviewOutcome {
  return {
    ...outcome("findings"),
    materialFindings: [
      {
        ...finding(),
        evidence: [{ ...finding().evidence[0], content: "x".repeat(64 * 1024) }],
      },
    ],
  } as ReviewOutcome;
}

// The validation cases keep the closed publication schema visible in one contract suite.
// oxlint-disable-next-line max-lines-per-function
describe("GitHub publication validation", () => {
  it("accepts every well-formed outcome variant", () => {
    for (const type of [
      "clean",
      "findings",
      "policy_skip",
      "unsupported_change",
      "abstention",
      "partial_coverage",
      "provider_failure",
      "budget_limit",
      "resource_limit",
      "timeout",
      "configuration_failure",
      "internal_failure",
    ] as const) {
      expect(parseGitHubReviewOutcome(outcome(type))).toBeDefined();
    }
  });

  it("accepts the provider-failure artifact emitted before a RunResult exists", () => {
    expect(parseGitHubReviewOutcome(providerFailureBeforeRunResult())).toBeDefined();
  });

  it("rejects forged clean outcomes and malformed nested publishing fields", () => {
    const clean = outcome("clean") as unknown as Record<string, unknown>;
    const findings = outcome("findings") as Extract<ReviewOutcome, { type: "findings" }>;
    const badFinding = findings.materialFindings[0];
    const cases: unknown[] = [
      { type: "clean", trust: trustedSameRepoTrust, pullRequest: reviewedPullRequest },
      { ...clean, trust: { ...trustedSameRepoTrust, class: "forged" } },
      {
        ...clean,
        trust: { ...trustedSameRepoTrust, capabilities: { publishing: "denied" } },
      },
      { ...clean, policy: { source: {}, effective: {} } },
      { ...findings, materialFindings: [{ ...badFinding, lifecycleState: "unknown" }] },
      {
        ...findings,
        materialFindings: [
          {
            ...badFinding,
            verificationState: { ...badFinding.verificationState, type: "guessed" },
          },
        ],
      },
      {
        ...findings,
        materialFindings: [{ ...badFinding, location: { ...badFinding.location, line: "7" } }],
      },
      {
        ...findings,
        materialFindings: [{ ...badFinding, location: { ...badFinding.location, line: 0 } }],
      },
      {
        ...findings,
        materialFindings: [{ ...badFinding, evidence: [{ type: "repository_file" }] }],
      },
    ];
    for (const value of cases) expect(parseGitHubReviewOutcome(value)).toBeUndefined();
  });
});

// The presentation suite keeps the cross-surface outcome mapping together.
// oxlint-disable-next-line max-lines-per-function
describe("GitHub publication presentation", () => {
  it("maps every Review outcome to a defensible check conclusion", () => {
    expect(
      Object.fromEntries(
        [
          "clean",
          "findings",
          "policy_skip",
          "unsupported_change",
          "abstention",
          "partial_coverage",
          "provider_failure",
          "budget_limit",
          "resource_limit",
          "timeout",
          "configuration_failure",
          "internal_failure",
        ].map((type) => [type, checkConclusion(outcome(type as ReviewOutcome["type"]))]),
      ),
    ).toEqual({
      clean: "success",
      findings: "action_required",
      policy_skip: "skipped",
      unsupported_change: "skipped",
      abstention: "neutral",
      partial_coverage: "neutral",
      provider_failure: "failure",
      budget_limit: "failure",
      resource_limit: "failure",
      timeout: "timed_out",
      configuration_failure: "failure",
      internal_failure: "failure",
    });
  });

  it("renders every required Finding field and adapter reconciliation metadata", () => {
    const body = findingBody(finding());
    for (const phrase of [
      "Problem",
      "Impact",
      "Evidence",
      "Verification state",
      "Lifecycle state",
      "Recommended next action",
      "adapter-owned; not Finding identity",
    ]) {
      expect(body).toContain(phrase);
    }
    expect(findingBody(finding())).toBe(body);
  });

  it("keeps machine output bounded and labels an incomplete deterministic representation", () => {
    const rendered = checkOutput(outcomeWithLargeEvidence()).text;
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(GITHUB_BODY_LIMIT);
    expect(rendered).toContain("bounded representation; full outcome truncated");
    expect(rendered).toContain('"complete":false');
    expect(rendered).toContain('"sha256"');
  });

  it("keeps unanchored Findings in the maintained summary", () => {
    const findingsOutcome = {
      ...outcome("findings"),
      materialFindings: [finding(null)],
    } as ReviewOutcome;
    expect(summaryBody(findingsOutcome)).toContain("Findings without a current inline anchor");
    expect(summaryBody(findingsOutcome)).toContain("Null input crashes");
  });
});

// Publication scenarios stay grouped because they share the same observable request sequence.
// oxlint-disable-next-line max-lines-per-function
function publicationAdapterTests(): void {
  it("publishes one non-approving review for actionable findings", async () => {
    const { requests, transport } = fakeTransport();
    const findingsOutcome = outcome("findings");
    const receipt = await publishReviewOutcome(transport, target, findingsOutcome, authorization);

    expect(receipt).toEqual({
      result: "complete",
      headSha: target.headSha,
      reviewId: 41,
      inlineCommentCount: 1,
      unanchoredFindingCount: 0,
    });
    const review = requests.find((request) => request.path.endsWith("/reviews"));
    expect(review?.body).toMatchObject({
      commit_id: target.headSha,
      event: "COMMENT",
      comments: [{ path: "src/handler.ts", line: 7, side: "RIGHT" }],
    });
    expect(requests.some((request) => request.path.endsWith("/check-runs"))).toBe(false);
    expect(requests.some((request) => request.path.includes("/issues/comments"))).toBe(false);
    expect(findingsOutcome).not.toHaveProperty("publication");
  });

  it("publishes a valid outcome containing 64 KiB evidence without a duplicate check", async () => {
    const { requests, transport } = fakeTransport();
    await expect(
      publishReviewOutcome(transport, target, outcomeWithLargeEvidence(), authorization),
    ).resolves.toMatchObject({ result: "complete" });
    expect(requests.some((request) => request.path.endsWith("/check-runs"))).toBe(false);
  });

  it("rejects an actually oversized outcome before GitHub writes", async () => {
    const { requests, transport } = fakeTransport();
    const oversized = {
      ...outcome("provider_failure"),
      reason: "x".repeat(MAX_PUBLICATION_OUTCOME_BYTES + 1),
    };
    await expect(publishReviewOutcome(transport, target, oversized, authorization)).rejects.toThrow(
      "Refusing to publish",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
  });

  it("publishes the default pre-RunResult provider failure without PR timeline noise", async () => {
    const { requests, transport } = fakeTransport();
    await expect(
      publishReviewOutcome(transport, target, providerFailureBeforeRunResult(), authorization),
    ).resolves.toMatchObject({ result: "complete" });
    expect(requests.some((request) => request.method !== "GET")).toBe(false);
  });

  it("does not create a duplicate custom check run", async () => {
    const { requests, transport } = fakeTransport();
    await publishReviewOutcome(transport, target, outcome("findings"), authorization);
    expect(requests.some((request) => request.path.includes("/check-runs"))).toBe(false);
  });

  it("creates no current-summary comment for a clean review", async () => {
    const { requests, transport } = fakeTransport();
    await publishReviewOutcome(transport, target, outcome("clean"), authorization);
    expect(requests.some((request) => request.path.includes("/issues/comments"))).toBe(false);
  });

  it("does not patch stale comments during check-first publication", async () => {
    const { requests, reviewComments, transport } = fakeTransport({
      reviewComments: [
        {
          id: 51,
          body: `${FINDING_COMMENT_MARKER}\nold finding`,
          user: { login: "github-actions[bot]" },
        },
      ],
    });
    await publishReviewOutcome(transport, target, outcome("findings"), authorization);
    expect(requests.some((request) => request.method === "PATCH")).toBe(false);
    expect(reviewComments[0]?.body).toContain("old finding");
  });

  it("puts unanchored actionable findings in the pull-request review body", async () => {
    const { requests, transport } = fakeTransport({ existingSummary: true });
    const findingsOutcome = {
      ...outcome("findings"),
      materialFindings: [finding(null)],
    } as ReviewOutcome;
    const receipt = await publishReviewOutcome(transport, target, findingsOutcome, authorization);
    expect(receipt.reviewId).toBe(41);
    expect(receipt.inlineCommentCount).toBe(0);
    expect(receipt.unanchoredFindingCount).toBe(1);
    const review = requests.find((request) => request.path.endsWith("/reviews"));
    expect(JSON.stringify(review?.body)).toContain("Findings without a current inline anchor");
    expect(JSON.stringify(review?.body)).toContain(findingShortIdentity(finding(null)));
    expect(JSON.stringify(review?.body)).toContain(findingFingerprint.value);
  });

  it("rejects an outcome that is not bound to the publication target", async () => {
    const { requests, transport } = fakeTransport();
    const mismatched = {
      ...outcome("clean"),
      pullRequest: { ...reviewedPullRequest, number: 99 },
    } as ReviewOutcome;
    await expect(
      publishReviewOutcome(transport, target, mismatched, authorization),
    ).rejects.toThrow("Refusing to publish");
    expect(requests).toHaveLength(1);
  });

  it("rejects a stale current head before any write", async () => {
    const { requests, transport } = fakeTransport({
      currentHead: "3333333333333333333333333333333333333333",
    });
    await expect(
      publishReviewOutcome(transport, target, outcome("clean"), authorization),
    ).rejects.toThrow("Refusing to publish");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
  });

  // oxlint-disable-next-line max-lines-per-function
  it("requires explicit source-run provenance and valid runtime data", async () => {
    for (const [reviewOutcome, provenance] of [
      [outcome("clean"), undefined],
      [outcome("clean"), { ...authorization, sourceRunVerified: false }],
      [outcome("clean"), { ...authorization, surfaces: [] }],
      [{ type: "findings", trust: trustedSameRepoTrust, materialFindings: [{}] }, authorization],
    ] as const) {
      const { requests, transport } = fakeTransport();
      // Cases are sequential so each transport's pre-write request count is asserted independently.
      // oxlint-disable-next-line no-await-in-loop
      await expect(
        publishReviewOutcome(transport, target, reviewOutcome, provenance),
      ).rejects.toThrow("Refusing to publish");
      expect(requests).toHaveLength(1);
    }
  });

  it("falls back from invalid anchors and excludes inactive lifecycle states", async () => {
    const { requests, transport } = fakeTransport();
    const findings = [
      finding(7),
      { ...finding(8), lifecycleState: "accepted" as const },
      { ...finding(9), lifecycleState: "resolved" as const },
      finding(90),
    ];
    const result = { ...outcome("findings"), materialFindings: findings } as ReviewOutcome;
    const receipt = await publishReviewOutcome(
      transport,
      {
        ...target,
        changedLines: [
          { path: "src/handler.ts", line: 7 },
          { path: "src/handler.ts", line: 8 },
        ],
      },
      result,
      authorization,
    );
    expect(receipt.inlineCommentCount).toBe(2);
    expect(receipt.unanchoredFindingCount).toBe(1);
    const review = requests.find((request) => request.path.endsWith("/reviews"));
    expect(JSON.stringify(review?.body)).toContain("Findings without a current inline anchor");
  });

  it("does not create a summary comment when review publication fails", async () => {
    const { requests, transport } = fakeTransport({ existingSummary: true, failPath: "/reviews" });
    await expect(
      publishReviewOutcome(transport, target, outcome("findings"), authorization),
    ).rejects.toThrow("injected publication failure");
    expect(requests.some((request) => request.path.includes("/issues/comments"))).toBe(false);
  });

  it("fails if the head changes during publication", async () => {
    const { requests, transport } = fakeTransport({
      existingSummary: true,
      currentHeads: [target.headSha, "3333333333333333333333333333333333333333"],
    });
    await expect(
      publishReviewOutcome(transport, target, outcome("findings"), authorization),
    ).rejects.toThrow("stale Review outcome");
    expect(requests.some((request) => request.path.includes("/issues/comments"))).toBe(false);
  });

  it("returns a complete receipt for a clean review without visible PR effects", async () => {
    const { requests, transport } = fakeTransport();
    const receipt = await publishReviewOutcome(transport, target, outcome("clean"), authorization);
    expect(receipt).toEqual({
      result: "complete",
      headSha: target.headSha,
      inlineCommentCount: 0,
      unanchoredFindingCount: 0,
    });
    expect(requests.some((request) => request.method !== "GET")).toBe(false);
  });

  it("sets versioned GitHub API headers without exposing token in payloads", async () => {
    let init: RequestInit | undefined;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (_url, requestInit) => {
      init = requestInit;
      return new Response("{}", { status: 200 });
    };
    try {
      await createGitHubTransport("secret-token")({
        method: "POST",
        path: "/test",
        body: { safe: true },
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(init?.headers).toMatchObject({
      accept: "application/vnd.github+json",
      authorization: "Bearer secret-token",
      "x-github-api-version": "2022-11-28",
    });
    expect(init?.body).toBe('{"safe":true}');
  });
}

describe("GitHub publication adapter", () => {
  publicationAdapterTests();
});
