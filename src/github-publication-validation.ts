import type { ReviewOutcome } from "./review-engine.js";
import { classifyTrust } from "./trust.js";
import { parseGitHubReviewOutcome } from "./github-outcome-schema.js";
import {
  REQUIRED_PUBLICATION_SURFACES,
  type PublicationAuthorization,
  type PublicationTarget,
} from "./github-publication.js";

// Allows the maximum configured diff, 100 repository evidence items, 10 validation
// outputs, and bounded execution metadata while rejecting unbounded publisher input.
export const MAX_PUBLICATION_OUTCOME_BYTES = 16 * 1024 * 1024;

function matchesTarget(outcome: ReviewOutcome, target: PublicationTarget): boolean {
  return (
    "pullRequest" in outcome &&
    outcome.pullRequest.repository === target.repository &&
    outcome.pullRequest.number === target.pullRequestNumber &&
    outcome.pullRequest.headSha === target.headSha
  );
}

function surfacesAllowed(authorization: PublicationAuthorization | undefined): boolean {
  const surfaces = authorization?.surfaces;
  return (
    surfaces !== undefined &&
    surfaces.length === REQUIRED_PUBLICATION_SURFACES.length &&
    REQUIRED_PUBLICATION_SURFACES.every((surface) => surfaces.includes(surface))
  );
}

export function validatePublicationOutcome(
  outcome: unknown,
  target: PublicationTarget,
  authorization: PublicationAuthorization | undefined,
  headMatches: boolean,
): ReviewOutcome {
  let encoded: string;
  try {
    encoded = JSON.stringify(outcome);
  } catch {
    return rejectPublication();
  }
  const parsed = parseGitHubReviewOutcome(outcome);
  const sourceMatches = parsed !== undefined && matchesTarget(parsed, target);
  const trust = classifyTrust({
    type: "privileged_publisher",
    validation: {
      schemaValid: parsed !== undefined,
      sizeWithinLimit: Buffer.byteLength(encoded) <= MAX_PUBLICATION_OUTCOME_BYTES,
      sourceRunVerified: authorization?.sourceRunVerified === true,
      headShaMatches: headMatches,
      surfacesAllowed: surfacesAllowed(authorization),
      resultCurrent: headMatches && sourceMatches,
    },
  });
  if (trust.capabilities.publishing !== "sha_bound_data_only" || !sourceMatches)
    return rejectPublication();
  return parsed;
}

function rejectPublication(): never {
  throw new Error("Refusing to publish an invalid, oversized, or stale Review outcome.");
}
