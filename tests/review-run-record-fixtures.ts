import type { ProjectPolicy } from "../src/project-policy.js";
import type { ReviewOutcome } from "../src/review-outcome.js";
import { createReviewRunRecord } from "../src/review-run-record.js";
import {
  completedReviewOutcome,
  reviewedPullRequest,
  trustedSameRepoTrust,
} from "./review-fixtures.js";

export const policySource = {
  type: "trusted_base_branch" as const,
  revision: reviewedPullRequest.baseSha,
  path: ".diffowl.json" as const,
};

export function cleanOutcome(policy: ProjectPolicy): ReviewOutcome {
  return completedReviewOutcome({
    trust: trustedSameRepoTrust,
    policy,
    policySource,
    verification: {
      evidenceCatalog: [],
      validationAttempts: [
        {
          commandIndex: 0,
          argv: ["npm", "test"],
          timeoutSeconds: 30,
          status: "passed",
          exitCode: 0,
          stdout: "secret raw output",
          stderr: "secret raw error",
          truncated: false,
        },
      ],
      limitations: [],
      coverageGaps: [],
    },
  }) as unknown as ReviewOutcome;
}

export function createRecord(outcome: ReviewOutcome, policy?: ProjectPolicy) {
  return createReviewRunRecord({
    runId: "run-1",
    recordedAt: "2026-01-02T03:04:05.000Z",
    engineVersion: "0.1.0-test",
    revision:
      "pullRequest" in outcome
        ? { pullRequest: outcome.pullRequest, mergeBaseSha: outcome.pullRequest.baseSha }
        : undefined,
    trust: outcome.trust,
    policy,
    validationAttempts: [],
    finalOutcome: outcome,
  });
}
