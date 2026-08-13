import { describe, expect, it } from "vitest";

import { type PullRequestInput, runReview } from "../src/review-engine.js";

const reviewedPullRequest = {
  repository: "example/review-target",
  number: 42,
  baseSha: "1111111111111111111111111111111111111111",
  headSha: "2222222222222222222222222222222222222222",
};

const effectivePolicy = {
  version: 1,
  scope: {
    includePaths: ["src/**"],
    excludePaths: ["dist/**"],
  },
  limits: {
    reviewTimeoutSeconds: 600,
    maxFindings: 25,
  },
};

const representativePullRequest: PullRequestInput = {
  ...reviewedPullRequest,
  diff: [
    "diff --git a/message.txt b/message.txt",
    "index ce01362..94954ab 100644",
    "--- a/message.txt",
    "+++ b/message.txt",
    "@@ -1 +1 @@",
    "-hello",
    "+hello owl",
    "",
  ].join("\n"),
  trust: {
    class: "trusted_same_repo_pull_request",
    capabilities: {
      validationCommands: "sandboxed",
      secrets: "denied",
      writeTokens: "denied",
      privilegedTools: "denied",
      publishing: "denied",
    },
  },
  policy: {
    source: {
      type: "trusted_base_branch" as const,
      revision: reviewedPullRequest.baseSha,
      path: ".diffowl.json",
    },
    contents: JSON.stringify(effectivePolicy),
  },
};

describe("runReview", () => {
  it("returns a typed partial-coverage outcome for the tracer review", async () => {
    const outcome = await runReview(representativePullRequest);

    expect(outcome).toEqual({
      type: "partial_coverage",
      pullRequest: reviewedPullRequest,
      reason: "The tracer path does not analyze changes yet.",
      trust: representativePullRequest.trust,
      policy: {
        source: representativePullRequest.policy.source,
        effective: effectivePolicy,
      },
    });
  });

  it("fails closed when policy exceeds a non-overridable ceiling", async () => {
    const outcome = await runReview({
      ...representativePullRequest,
      policy: {
        ...representativePullRequest.policy,
        contents: JSON.stringify({
          version: 1,
          scope: { includePaths: ["**"], excludePaths: [] },
          limits: { reviewTimeoutSeconds: 3_601, maxFindings: 25 },
        }),
      },
    });

    expect(outcome).toMatchObject({
      type: "configuration_failure",
      policySource: representativePullRequest.policy.source,
      reason: "Project policy limits.reviewTimeoutSeconds exceeds the security ceiling of 3600.",
    });
  });

  it("returns a typed configuration outcome for invalid policy JSON", async () => {
    const outcome = await runReview({
      ...representativePullRequest,
      policy: {
        ...representativePullRequest.policy,
        contents: "{not json}",
      },
    });

    expect(outcome).toEqual({
      type: "configuration_failure",
      pullRequest: reviewedPullRequest,
      policySource: representativePullRequest.policy.source,
      reason: "Project policy is not valid JSON.",
      trust: representativePullRequest.trust,
    });
  });
});
