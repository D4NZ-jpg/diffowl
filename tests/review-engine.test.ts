import { describe, expect, it } from "vitest";

import {
  type PullRequestInput,
  type RoleExecutionRequest,
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
  scope: {
    includePaths: ["src/**"],
    excludePaths: ["dist/**"],
  },
  limits: {
    reviewTimeoutSeconds: 600,
    maxFindings: 25,
  },
  roleProfiles: {
    reviewer: {
      provider: "openai",
      model: "gpt-5",
      credentialProfile: "primary",
    },
    challenger: {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      credentialProfile: "primary",
    },
    verifier: {
      provider: "openai",
      model: "gpt-5-mini",
      credentialProfile: "primary",
    },
  },
};

const representativePullRequest: PullRequestInput = {
  ...reviewedPullRequest,
  diff: [
    "diff --git a/message.txt b/message.txt",
    "index ce01362..94954ab 100644",
    "--- a/message.txt",
    "+++ b/message.txt",
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

// The suite keeps profile resolution and typed execution failures together.
// oxlint-disable-next-line max-lines-per-function
describe("runReview role execution", () => {
  it("supplies role profiles and opaque RunCell credential configurations", async () => {
    let execution: RoleExecutionRequest | undefined;
    const credentials = { type: "env" as const };

    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: credentials },
      executeRoles: async (request) => {
        execution = request;
        return { type: "completed" };
      },
    });

    expect(execution).toMatchObject({
      roles: {
        reviewer: {
          profile: effectivePolicy.roleProfiles.reviewer,
          credentials,
        },
        challenger: {
          profile: effectivePolicy.roleProfiles.challenger,
          credentials,
        },
        verifier: {
          profile: effectivePolicy.roleProfiles.verifier,
          credentials,
        },
      },
    });
    expect(outcome).toEqual({
      type: "partial_coverage",
      pullRequest: reviewedPullRequest,
      reason: "The tracer path does not analyze changes yet.",
      trust: representativePullRequest.trust,
      policy: {
        source: representativePullRequest.policy.source,
        effective: effectivePolicy,
      },
    });
  });

  it("passes a custom shared store without exposing its credential blob", async () => {
    const store = {
      withLock: async <T>() => Promise.reject<T>(new Error("not invoked by the engine")),
    };
    let execution: RoleExecutionRequest | undefined;

    await runReview(representativePullRequest, {
      credentialProfiles: {
        primary: { type: "shared", key: "team-codex", store },
      },
      executeRoles: async (request) => {
        execution = request;
        return { type: "completed" };
      },
    });

    expect(execution?.roles.reviewer.credentials).toEqual({
      type: "shared",
      key: "team-codex",
      store,
    });
    expect(execution).not.toHaveProperty("roles.reviewer.credential");
  });

  it("returns a typed provider failure when role execution fails", async () => {
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      executeRoles: async () => {
        throw new Error("provider unavailable");
      },
    });

    expect(outcome).toMatchObject({
      type: "provider_failure",
      reason: "Provider role execution failed.",
      policy: { effective: effectivePolicy },
    });
  });

  it("returns a typed budget-limit outcome from role execution", async () => {
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      executeRoles: async () => ({
        type: "budget_limit",
        reason: "provider output exceeded the protective ceiling",
      }),
    });

    expect(outcome).toMatchObject({
      type: "budget_limit",
      reason: "provider output exceeded the protective ceiling",
      policy: { effective: effectivePolicy },
    });
  });
});

describe("runReview budget enforcement", () => {
  it("enforces the configured hard review timeout", async () => {
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
        executeRoles: async (request) => {
          signal = request.signal;
          return new Promise(() => undefined);
        },
      },
    );

    expect(outcome).toMatchObject({ type: "timeout", timeoutSeconds: 1 });
    expect(signal?.aborted).toBe(true);
  });

  it("fails configuration when a referenced credential profile is missing", async () => {
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: {},
      executeRoles: async () => ({ type: "completed" }),
    });

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
      policy: {
        ...representativePullRequest.policy,
        contents: "{not json}",
      },
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
