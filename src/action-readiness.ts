import type { ReviewOutcome } from "./review-engine.js";

export function actionExitCodeForOutcome(outcome: ReviewOutcome): 0 | 1 {
  return outcome.type === "clean" ||
    outcome.type === "policy_skip" ||
    outcome.type === "unsupported_change"
    ? 0
    : 1;
}
