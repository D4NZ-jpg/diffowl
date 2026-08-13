/* oxlint-disable max-lines */
import { minimatch } from "minimatch";

import type { ProjectPolicy, ReviewRole, RoleProfile } from "./project-policy.js";

export type DiffowlStoredCredential =
  | { type: "api_key"; key?: string; env?: Record<string, string> }
  | {
      type: "oauth";
      access: string;
      refresh: string;
      expires: number;
      [key: string]: unknown;
    };

export type DiffowlAuthBlob = Record<string, DiffowlStoredCredential>;

export interface DiffowlCredentialStore {
  withLock<T>(
    key: string,
    operation: (
      current: DiffowlAuthBlob | undefined,
    ) => Promise<{ result: T; next?: DiffowlAuthBlob }>,
  ): Promise<T>;
}

export type DiffowlCredentials =
  | "local"
  | { type: "local"; agentDir?: string; allowInProduction?: boolean }
  | { type: "env" }
  | { type: "agentDir"; path: string }
  | { type: "shared"; key: string; store: DiffowlCredentialStore };

export interface ReviewedPullRequest {
  repository: string;
  number: number;
  baseSha: string;
  headSha: string;
}

export interface CandidateLocation {
  path: string;
  line?: number | undefined;
}

export interface CandidateDraft {
  summary: string;
  location: CandidateLocation;
  impact: string;
  evidence: string[];
}

export interface CandidateFinding extends CandidateDraft {
  verification: {
    state: "strengthened" | "limited";
    explanation: string;
    evidence: string[];
  };
}

export interface AdvisorySuggestion {
  summary: string;
  rationale: string;
  location?: CandidateLocation | undefined;
}

export type OrchestrationStep =
  | { role: "reviewer"; purpose: "generate_candidates" }
  | { role: "challenger"; purpose: "challenge_candidates" }
  | { role: "verifier"; purpose: "verify_candidates" };

export interface OrchestrationPlan {
  maxCandidateFindings: number;
  steps: OrchestrationStep[];
}

export interface RoleExecutionEvent {
  type: "tool_call" | "tool_result" | "file_change" | "repair" | "finish" | "error";
  detail: unknown;
}

export interface ExecutionSnapshot {
  version: 1;
  files: Array<{ path: string; data: string }>;
}

export interface ExecutionFile {
  path: string;
  change: "create" | "modify";
  bytes: Uint8Array;
}

export interface RoleExecutionArtifact {
  role: ReviewRole;
  snapshot: ExecutionSnapshot;
  events: RoleExecutionEvent[];
  files: ExecutionFile[];
  sessionId: string;
  finishReason: string;
}

export interface ChallengerAssessment {
  candidateIndex: number;
  verdict: "support" | "reject" | "downgrade";
  reason: string;
}

export interface VerifierAssessment {
  candidateIndex: number;
  state: "strengthened" | "limited" | "rejected";
  explanation: string;
  evidence: string[];
}

export type RoleOutput =
  | {
      role: "reviewer";
      candidateFindings: CandidateDraft[];
      advisorySuggestions: AdvisorySuggestion[];
    }
  | { role: "challenger"; assessments: ChallengerAssessment[] }
  | { role: "verifier"; assessments: VerifierAssessment[] };

export interface RoleExecutionRequest {
  pullRequest: ReviewedPullRequest;
  diff: string;
  step: OrchestrationStep;
  profile: RoleProfile;
  credentials: DiffowlCredentials;
  roleInput: unknown;
  maxCandidateFindings: number;
  signal: AbortSignal;
}

export type RoleExecutionResult =
  | { type: "completed"; output: RoleOutput; artifact: RoleExecutionArtifact }
  | {
      type: "provider_failure" | "budget_limit";
      reason: string;
      artifact?: RoleExecutionArtifact | undefined;
    };

export type RoleExecutor = (request: RoleExecutionRequest) => Promise<RoleExecutionResult>;

export type ResolvedRole = { profile: RoleProfile; credentials: DiffowlCredentials };
export type ResolvedRoles = Record<ReviewRole, ResolvedRole>;

export type OrchestrationExecutionResult =
  | {
      type: "completed";
      candidateFindings: CandidateFinding[];
      advisorySuggestions: AdvisorySuggestion[];
      executionArtifacts: RoleExecutionArtifact[];
    }
  | {
      type: "provider_failure" | "budget_limit";
      reason: string;
      executionArtifacts: RoleExecutionArtifact[];
    };

export function orchestrationPlan(policy: ProjectPolicy): OrchestrationPlan {
  return {
    maxCandidateFindings: policy.limits.maxFindings,
    steps: [
      { role: "reviewer", purpose: "generate_candidates" },
      { role: "challenger", purpose: "challenge_candidates" },
      { role: "verifier", purpose: "verify_candidates" },
    ],
  };
}

const gitEscapeBytes: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

function decodeQuotedGitPath(value: string): string | undefined {
  const bytes: number[] = [];
  const encoder = new TextEncoder();
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      bytes.push(...encoder.encode(character));
      continue;
    }
    const escape = value[++index];
    if (escape === undefined) return undefined;
    const octal = /^[0-7]{1,3}/.exec(value.slice(index));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += octal[0].length - 1;
      continue;
    }
    const escapedByte = gitEscapeBytes[escape];
    if (escapedByte === undefined) return undefined;
    bytes.push(escapedByte);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}

function decodeGitPath(value: string): string | undefined {
  try {
    const path = value.startsWith('"') ? decodeQuotedGitPath(value) : value;
    return path?.startsWith("b/") === true ? path.slice(2) : undefined;
  } catch {
    return undefined;
  }
}

function diffPath(section: string): string | undefined {
  const header = /^diff --git (?:"(?:\\.|[^"\\])*"|\S+) ("(?:\\.|[^"\\])*"|\S+)$/m.exec(section);
  return header?.[1] === undefined ? undefined : decodeGitPath(header[1]);
}

function scopedDiff(diff: string, policy: ProjectPolicy): string {
  return diff
    .split(/(?=^diff --git )/m)
    .filter((section) => {
      const path = diffPath(section);
      if (path === undefined) return false;
      const included = policy.scope.includePaths.some((pattern) =>
        minimatch(path, pattern, { dot: true }),
      );
      const excluded = policy.scope.excludePaths.some((pattern) =>
        minimatch(path, pattern, { dot: true }),
      );
      return included && !excluded;
    })
    .join("");
}

function challengedCandidates(
  candidates: CandidateDraft[],
  advisories: AdvisorySuggestion[],
  assessments: ChallengerAssessment[],
): { candidates: CandidateDraft[]; advisories: AdvisorySuggestion[] } {
  const byIndex = new Map(assessments.map((assessment) => [assessment.candidateIndex, assessment]));
  const surviving: CandidateDraft[] = [];
  const updatedAdvisories = [...advisories];
  candidates.forEach((candidate, index) => {
    const assessment = byIndex.get(index);
    if (assessment?.verdict === "reject") return;
    if (assessment?.verdict === "downgrade") {
      updatedAdvisories.push({
        summary: candidate.summary,
        rationale: assessment.reason,
        location: candidate.location,
      });
      return;
    }
    surviving.push(candidate);
  });
  return { candidates: surviving, advisories: updatedAdvisories };
}

function verifiedCandidates(
  candidates: CandidateDraft[],
  assessments: VerifierAssessment[],
): CandidateFinding[] {
  const byIndex = new Map(assessments.map((assessment) => [assessment.candidateIndex, assessment]));
  return candidates.flatMap((candidate, index) => {
    const assessment = byIndex.get(index);
    if (assessment?.state === "rejected") return [];
    return [
      {
        ...candidate,
        verification: assessment
          ? {
              state: assessment.state,
              explanation: assessment.explanation,
              evidence: assessment.evidence,
            }
          : {
              state: "limited",
              explanation: "The verifier returned no assessment for this candidate.",
              evidence: [],
            },
      },
    ];
  });
}

export async function orchestrateReviewRoles(
  pullRequest: ReviewedPullRequest,
  diff: string,
  policy: ProjectPolicy,
  roles: ResolvedRoles,
  executeRole: RoleExecutor,
  signal: AbortSignal,
  artifacts: RoleExecutionArtifact[] = [],
): Promise<OrchestrationExecutionResult> {
  const plan = orchestrationPlan(policy);
  let candidates: CandidateDraft[] = [];
  let advisories: AdvisorySuggestion[] = [];
  let roleInput: unknown = { task: "generate candidates" };
  let verification: VerifierAssessment[] = [];
  for (const step of plan.steps) {
    const configuredRole = roles[step.role];
    // Roles are deliberately sequential because each consumes the prior role's output.
    // oxlint-disable-next-line no-await-in-loop
    const result = await executeRole({
      pullRequest,
      diff: scopedDiff(diff, policy),
      step,
      profile: configuredRole.profile,
      credentials: configuredRole.credentials,
      roleInput,
      maxCandidateFindings: plan.maxCandidateFindings,
      signal,
    });
    if (result.type !== "completed") {
      if (result.artifact !== undefined) artifacts.push(result.artifact);
      return { ...result, executionArtifacts: artifacts };
    }
    artifacts.push(result.artifact);
    if (result.output.role !== step.role) {
      return {
        type: "provider_failure",
        reason: `Provider returned ${result.output.role} output for the ${step.role} role.`,
        executionArtifacts: artifacts,
      };
    }
    if (result.output.role === "reviewer") {
      candidates = result.output.candidateFindings;
      advisories = result.output.advisorySuggestions;
      roleInput = result.output;
    } else if (result.output.role === "challenger") {
      const challenged = challengedCandidates(candidates, advisories, result.output.assessments);
      candidates = challenged.candidates;
      advisories = challenged.advisories;
      roleInput = { candidateFindings: candidates };
    } else {
      verification = result.output.assessments;
    }
  }
  return {
    type: "completed",
    candidateFindings: verifiedCandidates(candidates, verification),
    advisorySuggestions: advisories,
    executionArtifacts: artifacts,
  };
}
