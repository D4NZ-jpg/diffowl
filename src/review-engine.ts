import {
  type PolicySource,
  type ProjectPolicy,
  type ProjectPolicyInput,
  type ReviewRole,
  type RoleProfile,
  parseProjectPolicy,
} from "./project-policy.js";
import type { Credentials } from "runcell";

import type { TrustClassification } from "./trust.js";

export type DiffowlCredentials = Exclude<Credentials, { type: "apiKeys" }>;

export type {
  PolicySource,
  ProjectPolicy,
  ProjectPolicyInput,
  ReviewRole,
  RoleProfile,
  RoleProfiles,
} from "./project-policy.js";
export { PROJECT_POLICY_CEILINGS, PROJECT_POLICY_PATH } from "./project-policy.js";
export type {
  PublisherValidation,
  TrustCapabilities,
  TrustClassification,
  TrustContext,
} from "./trust.js";
export { classifyTrust } from "./trust.js";

export interface ReviewedPullRequest {
  repository: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export interface PullRequestInput extends ReviewedPullRequest {
  diff: string;
  policy: ProjectPolicyInput;
  trust: TrustClassification;
}

interface OutcomeBase {
  pullRequest: ReviewedPullRequest;
  trust: TrustClassification;
}

interface ConfiguredOutcomeBase extends OutcomeBase {
  policy: { source: PolicySource; effective: ProjectPolicy };
}

export type ReviewOutcome =
  | { type: "policy_skip"; reason: string; trust: TrustClassification }
  | (ConfiguredOutcomeBase & { type: "partial_coverage"; reason: string })
  | (ConfiguredOutcomeBase & {
      type: "provider_failure" | "budget_limit";
      reason: string;
    })
  | (ConfiguredOutcomeBase & { type: "timeout"; timeoutSeconds: number })
  | (OutcomeBase & {
      type: "configuration_failure";
      reason: string;
      policySource: PolicySource;
    });

export interface RoleExecutionRequest {
  pullRequest: ReviewedPullRequest;
  diff: string;
  roles: Record<ReviewRole, { profile: RoleProfile; credentials: DiffowlCredentials }>;
  signal: AbortSignal;
}

export type RoleExecutionResult =
  | { type: "completed" }
  | { type: "provider_failure" | "budget_limit"; reason: string };

export interface ReviewDependencies {
  credentialProfiles: Readonly<Record<string, DiffowlCredentials>>;
  executeRoles(request: RoleExecutionRequest): Promise<RoleExecutionResult>;
}

const defaultDependencies: ReviewDependencies = {
  credentialProfiles: { default: { type: "env" } },
  executeRoles: async () => ({ type: "completed" }),
};

function pullRequestFrom(input: PullRequestInput): ReviewedPullRequest {
  return {
    repository: input.repository,
    number: input.number,
    baseSha: input.baseSha,
    headSha: input.headSha,
  };
}

function partialCoverageReason(trust: TrustClassification): string {
  return trust.class === "untrusted_pull_request"
    ? "Trust restrictions permit static review only; validation commands are denied."
    : "The tracer path does not analyze changes yet.";
}

function configurationFailure(input: PullRequestInput, reason: string): ReviewOutcome {
  return {
    type: "configuration_failure",
    pullRequest: pullRequestFrom(input),
    policySource: input.policy.source,
    reason,
    trust: input.trust,
  };
}

function resolveRole(
  name: ReviewRole,
  policy: ProjectPolicy,
  credentialProfiles: ReviewDependencies["credentialProfiles"],
): { profile: RoleProfile; credentials: DiffowlCredentials } | string {
  const profile = policy.roleProfiles[name];
  const credentials = Object.hasOwn(credentialProfiles, profile.credentialProfile)
    ? credentialProfiles[profile.credentialProfile]
    : undefined;
  return credentials === undefined
    ? `Credential profile "${profile.credentialProfile}" required by ${name} role is missing.`
    : { profile, credentials };
}

function roleExecutionRequest(
  input: PullRequestInput,
  policy: ProjectPolicy,
  dependencies: ReviewDependencies,
  signal: AbortSignal,
): RoleExecutionRequest | string {
  const reviewer = resolveRole("reviewer", policy, dependencies.credentialProfiles);
  if (typeof reviewer === "string") return reviewer;
  const challenger = resolveRole("challenger", policy, dependencies.credentialProfiles);
  if (typeof challenger === "string") return challenger;
  const verifier = resolveRole("verifier", policy, dependencies.credentialProfiles);
  if (typeof verifier === "string") return verifier;
  return {
    pullRequest: pullRequestFrom(input),
    diff: input.diff,
    roles: { reviewer, challenger, verifier },
    signal,
  };
}

async function executeWithinTimeout(
  request: RoleExecutionRequest,
  timeoutSeconds: number,
  executeRoles: ReviewDependencies["executeRoles"],
  controller: AbortController,
): Promise<RoleExecutionResult | { type: "timeout" }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ type: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ type: "timeout" });
    }, timeoutSeconds * 1_000);
  });
  try {
    return await Promise.race([executeRoles(request), timeout]);
  } catch {
    return {
      type: "provider_failure",
      reason: "Provider role execution failed.",
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runReview(
  input: PullRequestInput,
  dependencies: ReviewDependencies = defaultDependencies,
): Promise<ReviewOutcome> {
  const result = parseProjectPolicy(input.policy.contents);
  if (!result.valid) return configurationFailure(input, result.reason);
  const configured = {
    pullRequest: pullRequestFrom(input),
    trust: input.trust,
    policy: { source: input.policy.source, effective: result.policy },
  };
  const providerCredentialsAllowed =
    input.trust.capabilities.secrets === "provider_credentials_only" ||
    input.trust.capabilities.secrets === "local_user_authorized";
  if (!providerCredentialsAllowed) {
    return {
      ...configured,
      type: "partial_coverage",
      reason: partialCoverageReason(input.trust),
    };
  }
  const controller = new AbortController();
  const request = roleExecutionRequest(input, result.policy, dependencies, controller.signal);
  if (typeof request === "string") return configurationFailure(input, request);
  const execution = await executeWithinTimeout(
    request,
    result.policy.limits.reviewTimeoutSeconds,
    dependencies.executeRoles,
    controller,
  );
  if (execution.type === "timeout") {
    return {
      ...configured,
      type: "timeout",
      timeoutSeconds: result.policy.limits.reviewTimeoutSeconds,
    };
  }
  if (execution.type !== "completed") return { ...configured, ...execution };
  return {
    ...configured,
    type: "partial_coverage",
    reason: partialCoverageReason(input.trust),
  };
}
