export const PROJECT_POLICY_PATH = ".diffowl.json";

export const PROJECT_POLICY_CEILINGS = {
  reviewTimeoutSeconds: 3_600,
  maxFindings: 100,
} as const;

export interface ReviewedPullRequest {
  repository: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export type PolicySource =
  | {
      type: "trusted_base_branch";
      revision: string;
      path: typeof PROJECT_POLICY_PATH;
    }
  | {
      type: "local_invocation";
      path: string;
    };

export interface ProjectPolicyInput {
  source: PolicySource;
  contents: string | undefined;
}

export interface ProjectPolicy {
  version: 1;
  scope: {
    includePaths: string[];
    excludePaths: string[];
  };
  limits: {
    reviewTimeoutSeconds: number;
    maxFindings: number;
  };
}

export interface PullRequestInput extends ReviewedPullRequest {
  diff: string;
  policy: ProjectPolicyInput;
}

interface OutcomeBase {
  pullRequest: ReviewedPullRequest;
}

export type ReviewOutcome =
  | (OutcomeBase & {
      type: "partial_coverage";
      reason: string;
      policy: {
        source: PolicySource;
        effective: ProjectPolicy;
      };
    })
  | (OutcomeBase & {
      type: "configuration_failure";
      reason: string;
      policySource: PolicySource;
    });

function pullRequestFrom(input: PullRequestInput): ReviewedPullRequest {
  return {
    repository: input.repository,
    number: input.number,
    baseSha: input.baseSha,
    headSha: input.headSha,
  };
}

type PolicyParseResult = { valid: true; policy: ProjectPolicy } | { valid: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedField(
  value: Record<string, unknown>,
  supported: readonly string[],
  location: string,
): string | undefined {
  const field = Object.keys(value).find((key) => !supported.includes(key));
  return field === undefined
    ? undefined
    : `Project policy ${location} contains unsupported field "${field}".`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateScope(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "Project policy scope must be an object.";
  }
  const fieldError = unsupportedField(value, ["includePaths", "excludePaths"], "scope");
  if (fieldError !== undefined) {
    return fieldError;
  }
  if (!isStringArray(value.includePaths) || !isStringArray(value.excludePaths)) {
    return "Project policy scope paths must be arrays of non-empty strings.";
  }
  return undefined;
}

function validateLimit(
  value: unknown,
  name: keyof typeof PROJECT_POLICY_CEILINGS,
): string | undefined {
  if (!isPositiveInteger(value)) {
    return `Project policy limits.${name} must be a positive integer.`;
  }
  const ceiling = PROJECT_POLICY_CEILINGS[name];
  return value > ceiling
    ? `Project policy limits.${name} exceeds the security ceiling of ${ceiling}.`
    : undefined;
}

function validateLimits(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "Project policy limits must be an object.";
  }
  const fieldError = unsupportedField(value, ["reviewTimeoutSeconds", "maxFindings"], "limits");
  return (
    fieldError ??
    validateLimit(value.reviewTimeoutSeconds, "reviewTimeoutSeconds") ??
    validateLimit(value.maxFindings, "maxFindings")
  );
}

function validatePolicy(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return "Project policy must be a JSON object.";
  }
  const fieldError = unsupportedField(value, ["version", "scope", "limits"], "root");
  if (fieldError !== undefined) {
    return fieldError;
  }
  if (value.version !== 1) {
    return "Project policy version must be 1.";
  }
  return validateScope(value.scope) ?? validateLimits(value.limits);
}

function parseProjectPolicy(contents: string | undefined): PolicyParseResult {
  if (contents === undefined) {
    return { valid: false, reason: "Project policy is missing." };
  }

  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return { valid: false, reason: "Project policy is not valid JSON." };
  }

  const reason = validatePolicy(value);
  if (reason !== undefined) {
    return { valid: false, reason };
  }

  return { valid: true, policy: value as ProjectPolicy };
}

export async function runReview(input: PullRequestInput): Promise<ReviewOutcome> {
  const result = parseProjectPolicy(input.policy.contents);
  if (!result.valid) {
    return {
      type: "configuration_failure",
      pullRequest: pullRequestFrom(input),
      policySource: input.policy.source,
      reason: result.reason,
    };
  }

  return {
    type: "partial_coverage",
    pullRequest: pullRequestFrom(input),
    reason: "The tracer path does not analyze changes yet.",
    policy: {
      source: input.policy.source,
      effective: result.policy,
    },
  };
}
