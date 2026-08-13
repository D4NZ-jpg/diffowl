/* oxlint-disable max-lines */
import { describe, expect, it } from "vitest";

import {
  type PullRequestInput,
  type RoleExecutionArtifact,
  type RoleExecutionRequest,
  type RoleExecutionResult,
  runReview,
} from "../src/review-engine.js";

const reviewedPullRequest = {
  repository: "example/review-target",
  number: 42,
  baseSha: "1111111111111111111111111111111111111111",
  headSha: "2222222222222222222222222222222222222222",
};

const effectivePolicy = {
  version: 1,
  scope: { includePaths: ["src/**"], excludePaths: ["dist/**"] },
  limits: { reviewTimeoutSeconds: 600, maxFindings: 25 },
  roleProfiles: {
    reviewer: { provider: "openai", model: "gpt-5", credentialProfile: "primary" },
    challenger: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credentialProfile: "primary",
    },
    verifier: { provider: "openai", model: "gpt-5-mini", credentialProfile: "primary" },
  },
};

const representativePullRequest: PullRequestInput = {
  ...reviewedPullRequest,
  diff: [
    "diff --git a/src/message.ts b/src/message.ts",
    "--- a/src/message.ts",
    "+++ b/src/message.ts",
    "@@ -1 +1 @@",
    "-hello",
    "+hello owl",
    "diff --git a/dist/message.js b/dist/message.js",
    "--- a/dist/message.js",
    "+++ b/dist/message.js",
    "@@ -1 +1 @@",
    "-hello",
    "+hello owl",
    "",
  ].join("\n"),
  trust: {
    class: "trusted_same_repo_pull_request",
    capabilities: {
      validationCommands: "sandboxed",
      secrets: "provider_credentials_only",
      writeTokens: "denied",
      privilegedTools: "denied",
      publishing: "denied",
    },
  },
  policy: {
    source: {
      type: "trusted_base_branch" as const,
      revision: reviewedPullRequest.baseSha,
      path: ".diffowl.json",
    },
    contents: JSON.stringify(effectivePolicy),
  },
};

function artifact(role: RoleExecutionRequest["step"]["role"]): RoleExecutionArtifact {
  return {
    role,
    snapshot: { version: 1, files: [] },
    events: [],
    files: [],
    sessionId: `${role}-session`,
    finishReason: "stop",
  };
}

function completedRole(request: RoleExecutionRequest): RoleExecutionResult {
  const role = request.step.role;
  if (role === "reviewer") {
    return {
      type: "completed",
      output: {
        role,
        candidateFindings: [
          {
            summary: "Greeting changes the public output",
            location: { path: "src/message.ts", line: 1 },
            impact: "Consumers receive a different value.",
            evidence: ["The changed line replaces hello with hello owl."],
          },
        ],
        advisorySuggestions: [
          {
            summary: "Document the greeting change",
            rationale: "The changed output may be user-visible.",
          },
        ],
      },
      artifact: artifact(role),
    };
  }
  if (role === "challenger") {
    return {
      type: "completed",
      output: {
        role,
        assessments: [{ candidateIndex: 0, verdict: "support", reason: "Material change." }],
      },
      artifact: artifact(role),
    };
  }
  return {
    type: "completed",
    output: {
      role,
      assessments: [
        {
          candidateIndex: 0,
          state: "limited",
          explanation: "No consumer context was available.",
          evidence: ["pull-request.diff"],
        },
      ],
    },
    artifact: artifact(role),
  };
}

// The suite keeps the complete three-role orchestration contract visible.
// oxlint-disable-next-line max-lines-per-function
describe("runReview role execution", () => {
  it("drives the role plan and returns structured candidates", async () => {
    const executions: RoleExecutionRequest[] = [];
    const credentials = { type: "env" as const };

    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: credentials },
      executeRole: async (request) => {
        executions.push(request);
        return completedRole(request);
      },
    });

    expect(executions.map(({ step }) => step)).toEqual([
      { role: "reviewer", purpose: "generate_candidates" },
      { role: "challenger", purpose: "challenge_candidates" },
      { role: "verifier", purpose: "verify_candidates" },
    ]);
    expect(executions[0]).toMatchObject({
      profile: effectivePolicy.roleProfiles.reviewer,
      credentials,
      maxCandidateFindings: 25,
    });
    expect(executions[0]?.diff).toContain("src/message.ts");
    expect(executions[0]?.diff).not.toContain("dist/message.js");
    expect(outcome).toMatchObject({
      type: "candidates_generated",
      candidateFindings: [
        {
          summary: "Greeting changes the public output",
          verification: { state: "limited", evidence: ["pull-request.diff"] },
        },
      ],
      advisorySuggestions: [{ summary: "Document the greeting change" }],
      orchestrationPlan: {
        maxCandidateFindings: 25,
        steps: [
          { role: "reviewer", purpose: "generate_candidates" },
          { role: "challenger", purpose: "challenge_candidates" },
          { role: "verifier", purpose: "verify_candidates" },
        ],
      },
      executionArtifacts: [{ role: "reviewer" }, { role: "challenger" }, { role: "verifier" }],
      policy: { effective: effectivePolicy },
    });
  });

  it("includes quoted Git paths in the configured review scope", async () => {
    let reviewerDiff = "";
    const quotedPathInput = {
      ...representativePullRequest,
      diff: 'diff --git "a/src/message\\tname.ts" "b/src/message\\tname.ts"\n-old\n+new\n',
    };

    await runReview(quotedPathInput, {
      credentialProfiles: { primary: { type: "env" } },
      executeRole: async (request) => {
        if (request.step.role === "reviewer") reviewerDiff = request.diff;
        return completedRole(request);
      },
    });

    expect(reviewerDiff).toContain('"b/src/message\\tname.ts"');
  });

  it("decodes octal-escaped UTF-8 Git paths in the configured review scope", async () => {
    let reviewerDiff = "";
    const quotedPathInput = {
      ...representativePullRequest,
      diff: 'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"\n-old\n+new\n',
    };

    await runReview(quotedPathInput, {
      credentialProfiles: { primary: { type: "env" } },
      executeRole: async (request) => {
        if (request.step.role === "reviewer") reviewerDiff = request.diff;
        return completedRole(request);
      },
    });

    expect(reviewerDiff).toContain('"b/src/caf\\303\\251.ts"');
  });

  it("passes a custom shared store without exposing its credential blob", async () => {
    const store = {
      withLock: async <T>() => Promise.reject<T>(new Error("not invoked by the engine")),
    };
    let execution: RoleExecutionRequest | undefined;

    await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "shared", key: "team-codex", store } },
      executeRole: async (request) => {
        execution ??= request;
        return completedRole(request);
      },
    });

    expect(execution?.credentials).toEqual({ type: "shared", key: "team-codex", store });
    expect(execution).not.toHaveProperty("credential");
  });

  it("returns a typed provider failure when role execution fails", async () => {
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      executeRole: async () => Promise.reject(new Error("provider unavailable")),
    });

    expect(outcome).toMatchObject({
      type: "provider_failure",
      reason: "Provider role execution failed.",
      executionArtifacts: [],
    });
  });

  it("returns a typed budget-limit outcome from role execution", async () => {
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      executeRole: async () => ({
        type: "budget_limit",
        reason: "provider output exceeded the protective ceiling",
      }),
    });

    expect(outcome).toMatchObject({
      type: "budget_limit",
      reason: "provider output exceeded the protective ceiling",
      executionArtifacts: [],
    });
  });
});

describe("runReview budget enforcement", () => {
  it("enforces the configured hard review timeout and keeps completed artifacts", async () => {
    const timeoutPolicy = {
      ...effectivePolicy,
      limits: { ...effectivePolicy.limits, reviewTimeoutSeconds: 1 },
    };
    let signal: AbortSignal | undefined;

    const outcome = await runReview(
      {
        ...representativePullRequest,
        policy: {
          ...representativePullRequest.policy,
          contents: JSON.stringify(timeoutPolicy),
        },
      },
      {
        credentialProfiles: { primary: { type: "env" } },
        executeRole: async (request) => {
          signal = request.signal;
          return request.step.role === "reviewer"
            ? completedRole(request)
            : new Promise(() => undefined);
        },
      },
    );

    expect(outcome).toMatchObject({
      type: "timeout",
      timeoutSeconds: 1,
      executionArtifacts: [{ role: "reviewer" }],
    });
    expect(signal?.aborted).toBe(true);
  });

  it("fails configuration when a referenced credential profile is missing", async () => {
    const outcome = await runReview(representativePullRequest, { credentialProfiles: {} });

    expect(outcome).toMatchObject({
      type: "configuration_failure",
      reason: 'Credential profile "primary" required by reviewer role is missing.',
    });
  });
});

describe("runReview policy validation", () => {
  it("fails closed when policy exceeds a non-overridable ceiling", async () => {
    const outcome = await runReview({
      ...representativePullRequest,
      policy: {
        ...representativePullRequest.policy,
        contents: JSON.stringify({
          version: 1,
          scope: { includePaths: ["**"], excludePaths: [] },
          limits: { reviewTimeoutSeconds: 3_601, maxFindings: 25 },
        }),
      },
    });

    expect(outcome).toMatchObject({
      type: "configuration_failure",
      policySource: representativePullRequest.policy.source,
      reason: "Project policy limits.reviewTimeoutSeconds exceeds the security ceiling of 3600.",
    });
  });

  it("returns a typed configuration outcome for invalid policy JSON", async () => {
    const outcome = await runReview({
      ...representativePullRequest,
      policy: { ...representativePullRequest.policy, contents: "{not json}" },
    });

    expect(outcome).toEqual({
      type: "configuration_failure",
      pullRequest: reviewedPullRequest,
      policySource: representativePullRequest.policy.source,
      reason: "Project policy is not valid JSON.",
      trust: representativePullRequest.trust,
    });
  });
});
