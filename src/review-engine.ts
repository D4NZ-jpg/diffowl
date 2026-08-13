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

type PolicyParseResult =
  | { valid: true; policy: ProjectPolicy }
  | { valid: false; reason: string };

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
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string" && item.length > 0)
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
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

  if (!isRecord(value)) {
    return { valid: false, reason: "Project policy must be a JSON object." };
  }

  const rootFieldError = unsupportedField(
    value,
    ["version", "scope", "limits"],
    "root",
  );
  if (rootFieldError !== undefined) {
    return { valid: false, reason: rootFieldError };
  }
  if (value.version !== 1) {
    return { valid: false, reason: "Project policy version must be 1." };
  }
  if (!isRecord(value.scope)) {
    return { valid: false, reason: "Project policy scope must be an object." };
  }
  const scopeFieldError = unsupportedField(
    value.scope,
    ["includePaths", "excludePaths"],
    "scope",
  );
  if (scopeFieldError !== undefined) {
    return { valid: false, reason: scopeFieldError };
  }
  if (
    !isStringArray(value.scope.includePaths) ||
    !isStringArray(value.scope.excludePaths)
  ) {
    return {
      valid: false,
      reason:
        "Project policy scope paths must be arrays of non-empty strings.",
    };
  }
  if (!isRecord(value.limits)) {
    return { valid: false, reason: "Project policy limits must be an object." };
  }
  const limitsFieldError = unsupportedField(
    value.limits,
    ["reviewTimeoutSeconds", "maxFindings"],
    "limits",
  );
  if (limitsFieldError !== undefined) {
    return { valid: false, reason: limitsFieldError };
  }

  const { maxFindings, reviewTimeoutSeconds } = value.limits;
  if (!isPositiveInteger(reviewTimeoutSeconds)) {
    return {
      valid: false,
      reason:
        "Project policy limits.reviewTimeoutSeconds must be a positive integer.",
    };
  }
  if (reviewTimeoutSeconds > PROJECT_POLICY_CEILINGS.reviewTimeoutSeconds) {
    return {
      valid: false,
      reason: `Project policy limits.reviewTimeoutSeconds exceeds the security ceiling of ${PROJECT_POLICY_CEILINGS.reviewTimeoutSeconds}.`,
    };
  }
  if (!isPositiveInteger(maxFindings)) {
    return {
      valid: false,
      reason: "Project policy limits.maxFindings must be a positive integer.",
    };
  }
  if (maxFindings > PROJECT_POLICY_CEILINGS.maxFindings) {
    return {
      valid: false,
      reason: `Project policy limits.maxFindings exceeds the security ceiling of ${PROJECT_POLICY_CEILINGS.maxFindings}.`,
    };
  }

  return {
    valid: true,
    policy: {
      version: 1,
      scope: {
        includePaths: value.scope.includePaths,
        excludePaths: value.scope.excludePaths,
      },
      limits: { reviewTimeoutSeconds, maxFindings },
    },
  };
}

export async function runReview(
  input: PullRequestInput,
): Promise<ReviewOutcome> {
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
