import { describe, expect, it } from "vitest";

import { runReview } from "../src/review-engine.js";

const representativePullRequest = {
  repository: "example/review-target",
  number: 42,
  baseSha: "1111111111111111111111111111111111111111",
  headSha: "2222222222222222222222222222222222222222",
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
};

describe("runReview", () => {
  it("returns a typed partial-coverage outcome for the tracer review", async () => {
    const outcome = await runReview(representativePullRequest);

    expect(outcome).toEqual({
      type: "partial_coverage",
      pullRequest: {
        repository: "example/review-target",
        number: 42,
        baseSha: "1111111111111111111111111111111111111111",
        headSha: "2222222222222222222222222222222222222222",
      },
      reason: "The tracer path does not analyze changes yet.",
    });
  });
});
