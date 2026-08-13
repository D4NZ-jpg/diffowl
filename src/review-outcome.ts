import type { PolicySource, ProjectPolicy } from "./project-policy.js";
import type {
  AdvisorySuggestion,
  MaterialFinding,
  OrchestrationPlan,
  ReviewedPullRequest,
  RoleExecutionArtifact,
  VerificationContext,
} from "./review-orchestration.js";
import type { FindingLifecycleState } from "./review-orchestration.js";
import type { SafeReviewOutcomeRecord } from "./review-run-record.js";
import type { TrustClassification } from "./trust.js";

export interface ReviewRunMetadata {
  runId: string;
  recordVersion: number;
  outcome: SafeReviewOutcomeRecord;
  ledgerTransitions: Array<{
    fingerprint: string;
    lifecycleState: FindingLifecycleState;
  }>;
}

interface OutcomeBase {
  trust: TrustClassification;
  run?: ReviewRunMetadata | undefined;
}

interface PullRequestOutcomeBase extends OutcomeBase {
  pullRequest: ReviewedPullRequest;
}

interface ConfiguredOutcomeBase extends PullRequestOutcomeBase {
  policy: { source: PolicySource; effective: ProjectPolicy };
}

interface CompletedOutcomeBase extends ConfiguredOutcomeBase {
  coverage: "completed_permitted";
  advisorySuggestions: AdvisorySuggestion[];
  verification: VerificationContext;
  orchestrationPlan: OrchestrationPlan;
  executionArtifacts: RoleExecutionArtifact[];
}

export type ReviewOutcome =
  | (OutcomeBase & { type: "policy_skip"; reason: string })
  | (OutcomeBase & { type: "unsupported_change"; reason: string })
  | (CompletedOutcomeBase & { type: "clean"; materialFindings: [] })
  | (CompletedOutcomeBase & {
      type: "findings";
      materialFindings: [MaterialFinding, ...MaterialFinding[]];
    })
  | (ConfiguredOutcomeBase & {
      type: "abstention";
      reason: string;
      materialFindings: MaterialFinding[];
      advisorySuggestions: AdvisorySuggestion[];
      verification: VerificationContext;
      executionArtifacts: RoleExecutionArtifact[];
    })
  | (ConfiguredOutcomeBase & {
      type: "partial_coverage";
      reason: string;
      materialFindings?: MaterialFinding[];
      advisorySuggestions?: AdvisorySuggestion[];
      verification?: VerificationContext;
      orchestrationPlan?: OrchestrationPlan;
      executionArtifacts?: RoleExecutionArtifact[];
    })
  | (ConfiguredOutcomeBase & {
      type: "provider_failure" | "budget_limit" | "resource_limit";
      reason: string;
      executionArtifacts: RoleExecutionArtifact[];
    })
  | (ConfiguredOutcomeBase & {
      type: "timeout";
      timeoutSeconds: number;
      executionArtifacts: RoleExecutionArtifact[];
    })
  | (PullRequestOutcomeBase & {
      type: "configuration_failure";
      reason: string;
      policySource: PolicySource;
    })
  | (ConfiguredOutcomeBase & { type: "internal_failure"; reason: string });
