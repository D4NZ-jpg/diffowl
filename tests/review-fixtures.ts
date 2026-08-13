import type {
  ProjectPolicy,
  PolicySource,
  RoleExecutionArtifact,
  RoleExecutionRequest,
  RoleExecutionResult,
  TrustClassification,
  VerificationContext,
  VerifierAssessment,
} from "../src/review-engine.js";

export const reviewedPullRequest = {
  repository: "example/review-target",
  number: 42,
  baseSha: "1111111111111111111111111111111111111111",
  headSha: "2222222222222222222222222222222222222222",
};

export const trustedSameRepoTrust: TrustClassification = {
  class: "trusted_same_repo_pull_request",
  capabilities: {
    validationCommands: "sandboxed",
    secrets: "provider_credentials_only",
    writeTokens: "denied",
    privilegedTools: "denied",
    publishing: "denied",
  },
};

export const defaultRoleProfiles = {
  reviewer: { provider: "openai", model: "gpt-5", credentialProfile: "default" },
  challenger: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    credentialProfile: "default",
  },
  verifier: { provider: "openai", model: "gpt-5-mini", credentialProfile: "default" },
};

export function projectPolicy(overrides: Partial<ProjectPolicy> = {}): ProjectPolicy {
  return {
    version: 1,
    scope: { includePaths: ["src/**"], excludePaths: ["dist/**"] },
    limits: { reviewTimeoutSeconds: 600, maxFindings: 25 },
    verification: { validationCommands: [] },
    roleProfiles: defaultRoleProfiles,
    ...overrides,
  };
}

export function roleArtifact(role: RoleExecutionRequest["step"]["role"]): RoleExecutionArtifact {
  return {
    role,
    snapshot: { version: 1, files: [] },
    events: [],
    files: [],
    sessionId: `${role}-session`,
    finishReason: "stop",
  };
}

export function emptyRoleResult(request: RoleExecutionRequest): RoleExecutionResult {
  const role = request.step.role;
  const output =
    role === "reviewer"
      ? { role, candidateFindings: [], advisorySuggestions: [] }
      : { role, assessments: [] };
  return { type: "completed", output, artifact: roleArtifact(role) };
}

export function completedReviewOutcome(options: {
  trust: TrustClassification;
  policy: ProjectPolicy;
  policySource: PolicySource;
  verification: VerificationContext;
}): Record<string, unknown> {
  return {
    type: "clean",
    pullRequest: reviewedPullRequest,
    coverage: "completed_permitted",
    materialFindings: [],
    advisorySuggestions: [],
    orchestrationPlan: {
      maxCandidateFindings: 25,
      steps: [
        { role: "reviewer", purpose: "generate_candidates" },
        { role: "challenger", purpose: "challenge_candidates" },
        { role: "verifier", purpose: "verify_candidates" },
      ],
    },
    executionArtifacts: [
      roleArtifact("reviewer"),
      roleArtifact("challenger"),
      roleArtifact("verifier"),
    ],
    verification: options.verification,
    trust: options.trust,
    policy: { source: options.policySource, effective: options.policy },
  };
}

export function materialAssessment(evidenceIds: string[], explanation: string): VerifierAssessment {
  return {
    candidateIndex: 0,
    disposition: "material",
    evidenceIds,
    explanation,
    limitations: [],
  };
}

export function verifierResult(assessments: VerifierAssessment[]): RoleExecutionResult {
  return {
    type: "completed",
    output: { role: "verifier", assessments },
    artifact: roleArtifact("verifier"),
  };
}

export function pullRequestEvent(
  options: {
    headRepository?: string;
    actor?: string;
    baseRepository?: string;
  } = {},
): Record<string, unknown> {
  const repository = "example/review-target";
  return {
    repository: { full_name: repository },
    pull_request: {
      number: reviewedPullRequest.number,
      base: {
        sha: reviewedPullRequest.baseSha,
        repo: { full_name: options.baseRepository ?? repository },
      },
      head: {
        sha: reviewedPullRequest.headSha,
        repo: { full_name: options.headRepository ?? repository },
      },
      ...(options.actor === undefined ? {} : { user: { login: options.actor } }),
    },
  };
}
