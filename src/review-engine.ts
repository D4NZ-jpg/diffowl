export interface ReviewedPullRequest {
  repository: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export interface PullRequestInput extends ReviewedPullRequest {
  diff: string;
}

export type ReviewOutcome = {
  type: "partial_coverage";
  pullRequest: ReviewedPullRequest;
  reason: string;
};

export async function runReview(
  input: PullRequestInput,
): Promise<ReviewOutcome> {
  return {
    type: "partial_coverage",
    pullRequest: {
      repository: input.repository,
      number: input.number,
      baseSha: input.baseSha,
      headSha: input.headSha,
    },
    reason: "The tracer path does not analyze changes yet.",
  };
}
