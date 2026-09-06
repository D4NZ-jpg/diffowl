import { isRecord, type ProjectPolicy, unsupportedField } from "./project-policy.js";

/**
 * Whether a pull request from a fork is reviewed with the same capabilities as
 * a same-repository pull request when its author holds write, maintain, or
 * admin permission on the base repository. Off by default: on a public
 * repository a fork proves nothing about the author. Turn it on for teams that
 * work from personal forks of a private repository.
 */
export function collaboratorForksTrusted(policy: ProjectPolicy): boolean {
  return policy.trust?.collaboratorForks === true;
}

/**
 * Where advisory suggestions appear on GitHub. Material findings are always
 * published; this only controls the non-blocking tier.
 * - `off`: engine output only, nothing on GitHub.
 * - `summary`: one collapsed block at the end of the review body and a count in
 *   the job summary. Default.
 * - `inline`: each anchored advisory becomes its own review comment.
 */
export type AdvisoryPresentation = "off" | "summary" | "inline";

export const ADVISORY_PRESENTATIONS: readonly AdvisoryPresentation[] = ["off", "summary", "inline"];
export const ADVISORY_PRESENTATION_DEFAULT: AdvisoryPresentation = "summary";

export function advisoryPresentation(policy: ProjectPolicy): AdvisoryPresentation {
  return policy.presentation?.advisories ?? ADVISORY_PRESENTATION_DEFAULT;
}

function validatePresentation(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "Project policy presentation must be an object.";
  const fieldError = unsupportedField(value, ["advisories"], "presentation");
  if (fieldError !== undefined || value.advisories === undefined) return fieldError;
  return ADVISORY_PRESENTATIONS.includes(value.advisories as AdvisoryPresentation)
    ? undefined
    : `Project policy presentation.advisories must be one of ${ADVISORY_PRESENTATIONS.map((option) => `"${option}"`).join(", ")}.`;
}

function validateTrust(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return "Project policy trust must be an object.";
  const fieldError = unsupportedField(value, ["collaboratorForks"], "trust");
  if (fieldError !== undefined || value.collaboratorForks === undefined) return fieldError;
  return typeof value.collaboratorForks === "boolean"
    ? undefined
    : "Project policy trust.collaboratorForks must be a boolean.";
}

/** Validates the optional `presentation` and `trust` sections of a parsed policy object. */
export function validateOptionalSections(value: Record<string, unknown>): string | undefined {
  return validatePresentation(value.presentation) ?? validateTrust(value.trust);
}
