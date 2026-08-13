import {
  type PolicySource,
  type ProjectPolicy,
  type ProjectPolicyInput,
  type ReviewRole,
  parseProjectPolicy,
} from "./project-policy.js";
import {
  type DiffowlCredentials,
  type ResolvedRole,
  type ResolvedRoles,
  type ReviewedPullRequest,
  type RoleExecutionArtifact,
  type RoleExecutor,
  orchestrateReviewRoles,
  orchestrationPlan,
} from "./review-orchestration.js";
import { createRunCellRoleExecutor } from "./runcell-orchestration.js";
import type { TrustClassification } from "./trust.js";

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
  AdvisorySuggestion,
  CandidateDraft,
  CandidateFinding,
  CandidateLocation,
  ChallengerAssessment,
  DiffowlAuthBlob,
  DiffowlCredentials,
  DiffowlCredentialStore,
  DiffowlStoredCredential,
  ExecutionFile,
  ExecutionSnapshot,
  OrchestrationPlan,
  OrchestrationStep,
  ReviewedPullRequest,
  RoleExecutionArtifact,
  RoleExecutionEvent,
  RoleExecutionRequest,
  RoleExecutionResult,
  RoleOutput,
  VerifierAssessment,
} from "./review-orchestration.js";
export type {
  PublisherValidation,
  TrustCapabilities,
  TrustClassification,
  TrustContext,
} from "./trust.js";
export { classifyTrust } from "./trust.js";

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
  | (ConfiguredOutcomeBase & {
      type: "candidates_generated";
      candidateFindings: import("./review-orchestration.js").CandidateFinding[];
      advisorySuggestions: import("./review-orchestration.js").AdvisorySuggestion[];
      orchestrationPlan: import("./review-orchestration.js").OrchestrationPlan;
      executionArtifacts: RoleExecutionArtifact[];
    })
  | (ConfiguredOutcomeBase & { type: "partial_coverage"; reason: string })
  | (ConfiguredOutcomeBase & {
      type: "provider_failure" | "budget_limit";
      reason: string;
      executionArtifacts: RoleExecutionArtifact[];
    })
  | (ConfiguredOutcomeBase & {
      type: "timeout";
      timeoutSeconds: number;
      executionArtifacts: RoleExecutionArtifact[];
    })
  | (OutcomeBase & {
      type: "configuration_failure";
      reason: string;
      policySource: PolicySource;
    });

export interface ReviewDependencies {
  credentialProfiles?: Readonly<Record<string, DiffowlCredentials>> | undefined;
  executeRole?: RoleExecutor | undefined;
}

const defaultCredentialProfiles = { default: { type: "env" as const } };
const defaultExecuteRole = createRunCellRoleExecutor();

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
  credentialProfiles: Readonly<Record<string, DiffowlCredentials>>,
): ResolvedRole | string {
  const profile = policy.roleProfiles[name];
  const credentials = Object.hasOwn(credentialProfiles, profile.credentialProfile)
    ? credentialProfiles[profile.credentialProfile]
    : undefined;
  return credentials === undefined
    ? `Credential profile "${profile.credentialProfile}" required by ${name} role is missing.`
    : { profile, credentials };
}

function resolveRoles(
  policy: ProjectPolicy,
  credentialProfiles: Readonly<Record<string, DiffowlCredentials>>,
): ResolvedRoles | string {
  const reviewer = resolveRole("reviewer", policy, credentialProfiles);
  if (typeof reviewer === "string") return reviewer;
  const challenger = resolveRole("challenger", policy, credentialProfiles);
  if (typeof challenger === "string") return challenger;
  const verifier = resolveRole("verifier", policy, credentialProfiles);
  if (typeof verifier === "string") return verifier;
  return { reviewer, challenger, verifier };
}

async function executeWithinTimeout(
  execution: () => ReturnType<typeof orchestrateReviewRoles>,
  timeoutSeconds: number,
  controller: AbortController,
): Promise<Awaited<ReturnType<typeof orchestrateReviewRoles>> | { type: "timeout" }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ type: "timeout" }>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ type: "timeout" });
    }, timeoutSeconds * 1_000);
  });
  try {
    return await Promise.race([execution(), timeout]);
  } catch {
    return {
      type: "provider_failure",
      reason: "Provider role execution failed.",
      executionArtifacts: [],
    };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function runReview(
  input: PullRequestInput,
  dependencies: ReviewDependencies = {},
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
  const roles = resolveRoles(
    result.policy,
    dependencies.credentialProfiles ?? defaultCredentialProfiles,
  );
  if (typeof roles === "string") return configurationFailure(input, roles);
  const controller = new AbortController();
  const executionArtifacts: RoleExecutionArtifact[] = [];
  const execution = await executeWithinTimeout(
    () =>
      orchestrateReviewRoles(
        pullRequestFrom(input),
        input.diff,
        result.policy,
        roles,
        dependencies.executeRole ?? defaultExecuteRole,
        controller.signal,
        executionArtifacts,
      ),
    result.policy.limits.reviewTimeoutSeconds,
    controller,
  );
  if (execution.type === "timeout") {
    return {
      ...configured,
      type: "timeout",
      timeoutSeconds: result.policy.limits.reviewTimeoutSeconds,
      executionArtifacts,
    };
  }
  if (execution.type !== "completed") return { ...configured, ...execution };
  return {
    ...configured,
    type: "candidates_generated",
    candidateFindings: execution.candidateFindings,
    advisorySuggestions: execution.advisorySuggestions,
    orchestrationPlan: orchestrationPlan(result.policy),
    executionArtifacts: execution.executionArtifacts,
  };
}
