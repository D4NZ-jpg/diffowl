/* oxlint-disable max-lines */
import { describe, expect, it } from "vitest";

import {
  type PullRequestInput,
  type ReviewPersistenceStore,
  type RoleExecutionRequest,
  type RoleExecutionResult,
  type VerificationAdapter,
  runReview,
} from "../src/review-engine.js";
import {
  emptyRoleResult,
  materialAssessment,
  reviewedPullRequest,
  roleArtifact,
  trustedSameRepoTrust,
  verifierResult,
} from "./review-fixtures.js";

const effectivePolicy = {
  version: 1,
  scope: { includePaths: ["src/**"], excludePaths: ["dist/**"] },
  limits: { reviewTimeoutSeconds: 600, maxFindings: 25 },
  verification: {
    validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 30 }],
  },
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

const suggestedPatchPolicy = {
  ...effectivePolicy,
  verification: {
    validationCommands: [
      { argv: ["npm", "test"], timeoutSeconds: 30 },
      { argv: ["npm", "test", "--", "message"], timeoutSeconds: 20 },
    ],
    suggestedPatches: {
      sandboxImage: `node@sha256:${"a".repeat(64)}`,
      validationRules: [
        { includePaths: ["src/message.ts"], commandIndex: 1 },
        { includePaths: ["src/**"], commandIndex: 0 },
      ],
    },
  },
};

const passingVerificationAdapter: VerificationAdapter = {
  readRepositoryFile: async () => undefined,
  executeValidation: async () => ({
    status: "passed",
    exitCode: 0,
    stdout: "",
    stderr: "",
    truncated: false,
  }),
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
  trust: trustedSameRepoTrust,
  policy: {
    source: {
      type: "trusted_base_branch" as const,
      revision: reviewedPullRequest.baseSha,
      path: ".diffowl.json",
    },
    contents: JSON.stringify(effectivePolicy),
  },
};

function suggestedPatchPullRequest(): PullRequestInput {
  return {
    ...representativePullRequest,
    policy: {
      ...representativePullRequest.policy,
      contents: JSON.stringify(suggestedPatchPolicy),
    },
  };
}

function validationDeniedPullRequest(): PullRequestInput {
  return {
    ...representativePullRequest,
    trust: {
      class: "trusted_same_repo_pull_request",
      capabilities: {
        ...representativePullRequest.trust.capabilities,
        validationCommands: "denied",
      },
    },
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
      artifact: roleArtifact(role),
    };
  }
  if (role === "challenger") {
    return {
      type: "completed",
      output: {
        role,
        assessments: [{ candidateIndex: 0, verdict: "support", reason: "Material change." }],
      },
      artifact: roleArtifact(role),
    };
  }
  return {
    type: "completed",
    output: {
      role,
      assessments: [
        {
          candidateIndex: 0,
          disposition: "material",
          explanation: "The scoped diff demonstrates the changed output.",
          evidenceIds: ["scoped-diff"],
          limitations: ["Consumer call sites were not inspected."],
        },
      ],
    },
    artifact: roleArtifact(role),
  };
}

function completedRoleWithSuggestedPatch(
  request: RoleExecutionRequest,
  replacement = "hello",
  path = "src/message.ts",
): RoleExecutionResult {
  const result = completedRole(request);
  if (result.type === "completed" && result.output.role === "reviewer") {
    result.output.candidateFindings[0]!.location.path = path;
    result.output.candidateFindings[0]!.suggestedPatch = {
      startLine: 1,
      endLine: 1,
      replacement,
    };
  }
  return result;
}

async function reviewedDiff(diff: string): Promise<string> {
  let reviewerDiff = "";
  await runReview(
    { ...representativePullRequest, diff },
    {
      credentialProfiles: { primary: { type: "env" } },
      executeRole: async (request) => {
        if (request.step.role === "reviewer") reviewerDiff = request.diff;
        return completedRole(request);
      },
    },
  );
  return reviewerDiff;
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
      type: "partial_coverage",
      materialFindings: [
        {
          summary: "Greeting changes the public output",
          location: { path: "src/message.ts", line: 1 },
          impact: "Consumers receive a different value.",
          evidence: [{ id: "scoped-diff", type: "scoped_diff" }],
          lifecycleState: "new",
          verificationState: {
            type: "verified_with_limitations",
            explanation: "The scoped diff demonstrates the changed output.",
            limitations: expect.arrayContaining(["Consumer call sites were not inspected."]),
          },
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

  // The integration assertion keeps the full engine-owned evidence handoff visible.
  // oxlint-disable-next-line max-lines-per-function
  it("gathers exact-head repository evidence and trusted validation before verification", async () => {
    let verifierInput: unknown;
    const reads: Array<{ headSha: string; path: string; maxBytes: number }> = [];
    const commands: Array<{ argv: string[]; timeoutSeconds: number; maxOutputBytes: number }> = [];

    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      verificationAdapter: {
        readRepositoryFile: async (request) => {
          reads.push(request);
          return { content: "export const greeting = 'hello owl';", truncated: false };
        },
        executeValidation: async (request) => {
          commands.push(request);
          return {
            status: "passed",
            exitCode: 0,
            stdout: "1 test passed",
            stderr: "",
            truncated: false,
          };
        },
      },
      executeRole: async (request) => {
        if (request.step.role === "verifier") verifierInput = request.roleInput;
        return completedRole(request);
      },
    });

    expect(reads).toEqual([
      expect.objectContaining({
        headSha: reviewedPullRequest.headSha,
        path: "src/message.ts",
        maxBytes: 65_536,
      }),
    ]);
    expect(commands).toEqual([
      expect.objectContaining({
        argv: ["npm", "test"],
        timeoutSeconds: 30,
        maxOutputBytes: 65_536,
      }),
    ]);
    expect(verifierInput).toMatchObject({
      evidenceCatalog: [
        { id: "scoped-diff", type: "scoped_diff" },
        { id: "repository-file:0", type: "repository_file", path: "src/message.ts" },
        { id: "validation:0", type: "validation", content: "1 test passed" },
      ],
      validationAttempts: [{ status: "passed", argv: ["npm", "test"] }],
    });
    expect(outcome).toMatchObject({
      type: "findings",
      verification: {
        evidenceCatalog: [
          { id: "scoped-diff" },
          { id: "repository-file:0" },
          { id: "validation:0" },
        ],
        validationAttempts: [{ status: "passed" }],
      },
    });
  });

  // oxlint-disable-next-line max-lines-per-function
  it("attaches a Suggested patch only after exact-head isolated policy validation", async () => {
    const patchRequests: unknown[] = [];
    const outcome = await runReview(suggestedPatchPullRequest(), {
      credentialProfiles: { primary: { type: "env" } },
      verificationAdapter: {
        readRepositoryFile: async () => ({ content: "hello owl\n", truncated: false }),
        executeValidation: passingVerificationAdapter.executeValidation,
        validateSuggestedPatch: async (request) => {
          patchRequests.push(request);
          return {
            status: "passed",
            exitCode: 0,
            stdout: "passed",
            stderr: "",
            truncated: false,
          };
        },
      },
      executeRole: async (request) => completedRoleWithSuggestedPatch(request),
    });

    expect(patchRequests).toEqual([
      expect.objectContaining({
        repository: reviewedPullRequest.repository,
        headSha: reviewedPullRequest.headSha,
        path: "src/message.ts",
        startLine: 1,
        endLine: 1,
        expected: "hello owl",
        replacement: "hello",
        sandboxImage: `node@sha256:${"a".repeat(64)}`,
        command: expect.objectContaining({
          commandIndex: 1,
          argv: ["npm", "test", "--", "message"],
          timeoutSeconds: 20,
        }),
        security: expect.objectContaining({ network: "denied", secrets: "denied" }),
      }),
    ]);
    expect(outcome).toMatchObject({
      type: "findings",
      materialFindings: [
        {
          suggestedPatch: {
            path: "src/message.ts",
            startLine: 1,
            endLine: 1,
            replacement: "hello",
            reviewedHeadSha: reviewedPullRequest.headSha,
            validation: { commandIndex: 1, status: "passed" },
          },
        },
      ],
    });
  });

  // The table keeps patch-specific failures on the same public Review-engine fallback seam.
  // oxlint-disable-next-line max-lines-per-function
  it("keeps invalid, stale, and unvalidated proposals as ordinary actionable Findings", async () => {
    const pullRequestForPath = (path: string) => ({
      ...suggestedPatchPullRequest(),
      diff: representativePullRequest.diff.replaceAll("src/message.ts", path),
    });
    const cases = [
      {
        name: "failed proof",
        replacement: "hello",
        validate: async () => ({
          status: "failed" as const,
          exitCode: 1,
          stdout: "",
          stderr: "failed",
          truncated: false,
        }),
      },
      {
        name: "stale proof",
        replacement: "hello",
        validate: async () => ({
          status: "stale" as const,
          stdout: "",
          stderr: "",
          truncated: false,
        }),
      },
      {
        name: "replacement above 20 lines",
        replacement: Array.from({ length: 21 }, () => "line").join("\n"),
        validate: async () => ({
          status: "passed" as const,
          exitCode: 0,
          stdout: "passed",
          stderr: "",
          truncated: false,
        }),
      },
      ...[
        ["generated target", "src/generated/client.ts"],
        ["dependency manifest", "src/package.json"],
        ["Clojure dependency manifest", "src/deps.edn"],
        ["credential config", "src/.npmrc"],
        ["credential target", "src/service-secret.pem"],
        ["permission target", "src/permissions.yaml"],
        ["workflow target", "src/.woodpecker.yml"],
        ["generated protobuf target", "src/api.pb.go"],
        ["vendored target", "src/vendor/client.ts"],
      ].map(([name, path]) => ({
        name: name!,
        replacement: "hello",
        path: path!,
        pullRequest: pullRequestForPath(path!),
        validate: async () => ({
          status: "passed" as const,
          exitCode: 0,
          stdout: "passed",
          stderr: "",
          truncated: false,
        }),
      })),
      {
        name: "mode change",
        replacement: "hello",
        pullRequest: {
          ...suggestedPatchPullRequest(),
          diff: representativePullRequest.diff.replace(
            "diff --git a/src/message.ts b/src/message.ts\n",
            "diff --git a/src/message.ts b/src/message.ts\nold mode 100644\nnew mode 100755\n",
          ),
        },
        validate: async () => ({
          status: "passed" as const,
          exitCode: 0,
          stdout: "passed",
          stderr: "",
          truncated: false,
        }),
      },
      {
        name: "generated content",
        replacement: "hello",
        path: "src/api/client.ts",
        pullRequest: pullRequestForPath("src/api/client.ts"),
        repositoryContent: "// Code generated by Example. DO NOT EDIT.\nhello owl\n",
        validate: async () => ({
          status: "passed" as const,
          exitCode: 0,
          stdout: "passed",
          stderr: "",
          truncated: false,
        }),
      },
      {
        name: "non-text target",
        replacement: "hello",
        repositoryContent: "hello �\n",
        validate: async () => ({
          status: "passed" as const,
          exitCode: 0,
          stdout: "passed",
          stderr: "",
          truncated: false,
        }),
      },
    ];

    const outcomes = await Promise.all(
      cases.map(async (scenario) => ({
        scenario,
        outcome: await runReview(
          "pullRequest" in scenario ? scenario.pullRequest : suggestedPatchPullRequest(),
          {
            credentialProfiles: { primary: { type: "env" } },
            verificationAdapter: {
              readRepositoryFile: async () => ({
                content:
                  "repositoryContent" in scenario ? scenario.repositoryContent : "hello owl\n",
                truncated: false,
              }),
              executeValidation: passingVerificationAdapter.executeValidation,
              validateSuggestedPatch: scenario.validate,
            },
            executeRole: async (request) =>
              completedRoleWithSuggestedPatch(
                request,
                scenario.replacement,
                "path" in scenario ? scenario.path : undefined,
              ),
          },
        ),
      })),
    );

    for (const { outcome } of outcomes) {
      expect(outcome).toMatchObject({
        type: "findings",
        materialFindings: [
          {
            summary: "Greeting changes the public output",
            lifecycleState: "new",
          },
        ],
        verification: { coverageGaps: [] },
      });
      expect(
        outcome.type === "findings" ? outcome.materialFindings[0].suggestedPatch : undefined,
      ).toBeUndefined();
    }
  });

  it("does not read candidate locations outside the configured review scope", async () => {
    const reads: string[] = [];
    let verifierInput: { evidenceCatalog?: Array<{ path: string }> } | undefined;
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      verificationAdapter: {
        readRepositoryFile: async ({ path }) => {
          reads.push(path);
          return { content: "excluded content", truncated: false };
        },
        executeValidation: async () => ({
          status: "passed",
          exitCode: 0,
          stdout: "",
          stderr: "",
          truncated: false,
        }),
      },
      executeRole: async (request) => {
        if (request.step.role === "reviewer") {
          const result = completedRole(request);
          if (result.type === "completed" && result.output.role === "reviewer") {
            result.output.candidateFindings[0]!.location.path = "dist/model-supplied.js";
          }
          return result;
        }
        if (request.step.role === "verifier") {
          verifierInput = request.roleInput as typeof verifierInput;
        }
        return completedRole(request);
      },
    });

    expect(reads).toEqual([]);
    expect(verifierInput?.evidenceCatalog?.map(({ path }) => path)).not.toContain(
      "dist/model-supplied.js",
    );
    expect(outcome).toMatchObject({
      type: "findings",
      verification: {
        limitations: expect.arrayContaining([
          "Repository evidence was not read for out-of-scope path dist/model-supplied.js.",
        ]),
      },
    });
  });

  it("omits empty evidence and cannot materialize a Finding by citing it", async () => {
    const emptyDiffInput = { ...representativePullRequest, diff: "" };
    const outcome = await runReview(emptyDiffInput, {
      credentialProfiles: { primary: { type: "env" } },
      verificationAdapter: {
        ...passingVerificationAdapter,
        readRepositoryFile: async () => ({ content: "", truncated: false }),
      },
      executeRole: async (request) => {
        if (request.step.role !== "verifier") return completedRole(request);
        return verifierResult([
          materialAssessment(
            ["scoped-diff", "repository-file:0"],
            "Empty evidence supposedly proves the claim.",
          ),
        ]);
      },
    });

    expect(outcome).toMatchObject({
      type: "clean",
      advisorySuggestions: [{ summary: "Document the greeting change" }],
      verification: {
        evidenceCatalog: [],
        limitations: expect.arrayContaining([
          "The configured review scope produced an empty diff.",
          "Repository evidence for src/message.ts was empty.",
        ]),
      },
    });
  });

  // oxlint-disable-next-line complexity
  it("keeps multibyte verification evidence within byte ceilings", async () => {
    const multibyte = "😀".repeat(20_000);
    let verifierInput:
      | {
          evidenceCatalog?: Array<{ content: string }>;
          validationAttempts?: Array<{ stdout: string; stderr: string }>;
        }
      | undefined;
    await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      verificationAdapter: {
        readRepositoryFile: async () => ({ content: multibyte, truncated: false }),
        executeValidation: async () => ({
          status: "passed",
          exitCode: 0,
          stdout: multibyte,
          stderr: multibyte,
          truncated: false,
        }),
      },
      executeRole: async (request) => {
        if (request.step.role === "verifier") {
          verifierInput = request.roleInput as typeof verifierInput;
        }
        return completedRole(request);
      },
    });

    expect(
      verifierInput?.evidenceCatalog?.every(
        ({ content }) => Buffer.byteLength(content) <= 65_536 && !content.includes("�"),
      ),
    ).toBe(true);
    const attempt = verifierInput?.validationAttempts?.[0];
    expect(
      Buffer.byteLength(`${attempt?.stdout ?? ""}${attempt?.stderr ?? ""}`),
    ).toBeLessThanOrEqual(65_536);
    expect(`${attempt?.stdout ?? ""}${attempt?.stderr ?? ""}`).not.toContain("�");
  });

  it("keeps combined validation evidence within the exact byte ceiling including separator", async () => {
    let validationContent = "";
    await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      verificationAdapter: {
        readRepositoryFile: async () => undefined,
        executeValidation: async () => ({
          status: "passed",
          exitCode: 0,
          stdout: "a".repeat(65_534),
          stderr: "bé",
          truncated: false,
        }),
      },
      executeRole: async (request) => {
        if (request.step.role === "verifier") {
          const context = request.roleInput as {
            evidenceCatalog: Array<{ id: string; content: string }>;
          };
          validationContent =
            context.evidenceCatalog.find(({ id }) => id === "validation:0")?.content ?? "";
        }
        return completedRole(request);
      },
    });

    expect(Buffer.byteLength(validationContent)).toBe(65_536);
    expect(validationContent.endsWith("\nb")).toBe(true);
    expect(validationContent).not.toContain("é");
    expect(validationContent).not.toContain("�");
  });

  it("does not execute configured validation commands when the trust class denies them", async () => {
    let commandExecuted = false;
    let verifierInput: unknown;
    const outcome = await runReview(validationDeniedPullRequest(), {
      credentialProfiles: { primary: { type: "env" } },
      verificationAdapter: {
        readRepositoryFile: async () => undefined,
        executeValidation: async () => {
          commandExecuted = true;
          throw new Error("must not execute");
        },
      },
      executeRole: async (request) => {
        if (request.step.role === "verifier") verifierInput = request.roleInput;
        return completedRole(request);
      },
    });

    expect(outcome.type).toBe("partial_coverage");
    expect(commandExecuted).toBe(false);
    expect(verifierInput).toMatchObject({
      validationAttempts: [],
      limitations: expect.arrayContaining([
        "Configured validation commands were denied by the trust class.",
      ]),
    });
  });

  it("reports partial coverage when trust restrictions deny configured validation", async () => {
    const outcome = await runReview(validationDeniedPullRequest(), {
      credentialProfiles: { primary: { type: "env" } },
      executeRole: async (request) => emptyRoleResult(request),
    });

    expect(outcome).toMatchObject({
      type: "partial_coverage",
      reason:
        "Review coverage is partial: Configured validation commands were denied by the trust class.",
    });
  });

  it("does not let an unavailable validation attempt substantiate a material Finding", async () => {
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      verificationAdapter: {
        readRepositoryFile: async () => undefined,
        executeValidation: async () => ({
          status: "error",
          stdout: "",
          stderr: "",
          truncated: false,
          limitation: "Validation execution is unavailable.",
        }),
      },
      executeRole: async (request) => {
        if (request.step.role !== "verifier") return completedRole(request);
        return verifierResult([
          materialAssessment(
            ["validation:0"],
            "The unavailable command supposedly proves the claim.",
          ),
        ]);
      },
    });

    expect(outcome).toMatchObject({
      type: "partial_coverage",
      advisorySuggestions: [{ summary: "Document the greeting change" }],
      verification: {
        validationAttempts: [{ status: "error" }],
        limitations: expect.arrayContaining(["Validation execution is unavailable."]),
      },
    });
    expect(outcome.type === "partial_coverage" ? outcome.reason : "").toContain(
      "Validation execution is unavailable.",
    );
    expect(
      outcome.type === "partial_coverage"
        ? outcome.verification?.evidenceCatalog.map(({ id }) => id)
        : [],
    ).not.toContain("validation:0");
  });

  it("suppresses evidence-free material assessments and downgrades advisory dispositions", async () => {
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      verificationAdapter: passingVerificationAdapter,
      executeRole: async (request) => {
        if (request.step.role !== "verifier") return completedRole(request);
        return verifierResult([
          materialAssessment(["unknown-evidence"], "Unsupported material claim."),
          {
            candidateIndex: 0,
            disposition: "advisory",
            evidenceIds: [],
            explanation: "Worth considering but not material.",
            limitations: [],
          },
        ]);
      },
    });

    expect(outcome).toMatchObject({
      type: "clean",
      coverage: "completed_permitted",
      materialFindings: [],
      advisorySuggestions: [
        { summary: "Document the greeting change" },
        {
          summary: "Greeting changes the public output",
          rationale: "Worth considering but not material.",
        },
      ],
    });
  });

  it("abstains instead of appearing clean when a surviving candidate is not assessed", async () => {
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      executeRole: async (request) =>
        request.step.role === "verifier"
          ? verifierResult([
              {
                candidateIndex: 0,
                disposition: "abstain",
                evidenceIds: [],
                explanation: "Repository evidence is insufficient to judge the candidate.",
                limitations: ["The affected call sites were unavailable."],
              },
            ])
          : completedRole(request),
    });

    expect(outcome).toMatchObject({
      type: "abstention",
      reason: "Repository evidence is insufficient to judge the candidate.",
      advisorySuggestions: [{ summary: "Document the greeting change" }],
    });
  });

  it("includes quoted Git paths in the configured review scope", async () => {
    const diff = 'diff --git "a/src/message\\tname.ts" "b/src/message\\tname.ts"\n-old\n+new\n';

    expect(await reviewedDiff(diff)).toContain('"b/src/message\\tname.ts"');
  });

  it("decodes octal-escaped UTF-8 Git paths in the configured review scope", async () => {
    const diff = 'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"\n-old\n+new\n';

    expect(await reviewedDiff(diff)).toContain('"b/src/caf\\303\\251.ts"');
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
      reason: "Provider execution failed for the reviewer role.",
      executionArtifacts: [],
    });
  });

  it("returns a typed resource-limit outcome from role execution", async () => {
    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      executeRole: async () => ({
        type: "resource_limit",
        reason: "provider context exceeded the resource ceiling",
      }),
    });

    expect(outcome).toMatchObject({
      type: "resource_limit",
      reason: "provider context exceeded the resource ceiling",
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

// oxlint-disable-next-line max-lines-per-function
describe("runReview budget enforcement", () => {
  it("enforces the configured hard review timeout and keeps completed artifacts", async () => {
    const timeoutPolicy = {
      ...effectivePolicy,
      limits: { ...effectivePolicy.limits, reviewTimeoutSeconds: 1 },
      verification: {
        validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 1 }],
      },
    };
    let signal: AbortSignal | undefined;
    let finishLateExecution: (() => void) | undefined;

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
            : new Promise((resolve) => {
                finishLateExecution = () => resolve(completedRole(request));
              });
        },
      },
    );

    expect(outcome).toMatchObject({
      type: "timeout",
      timeoutSeconds: 1,
      executionArtifacts: [{ role: "reviewer" }],
    });
    expect(signal?.aborted).toBe(true);
    expect(outcome.type).toBe("timeout");
    if (outcome.type !== "timeout") throw new Error("Expected timeout outcome.");
    const returnedArtifacts = [...outcome.executionArtifacts];
    finishLateExecution?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outcome.executionArtifacts).toEqual(returnedArtifacts);
  });

  it("prepares required persistence before executing review roles", async () => {
    let executed = false;
    const persistence: ReviewPersistenceStore = {
      prepare: async () => {
        throw new Error(
          "GitHub Finding state is not configured correctly: Contents: write missing.",
        );
      },
      withTransaction: async () => {
        throw new Error("transaction should not start");
      },
    };

    const outcome = await runReview(representativePullRequest, {
      credentialProfiles: { primary: { type: "env" } },
      persistence,
      executeRole: async (request) => {
        executed = true;
        return emptyRoleResult(request);
      },
    });

    expect(executed).toBe(false);
    expect(outcome).toMatchObject({
      type: "configuration_failure",
      reason: "GitHub Finding state is not configured correctly: Contents: write missing.",
    });
  });

  it("fails configuration when a referenced credential profile is missing", async () => {
    const outcome = await runReview(representativePullRequest, { credentialProfiles: {} });

    expect(outcome).toMatchObject({
      type: "configuration_failure",
      reason: 'Credential profile "primary" required by reviewer role is missing.',
    });
  });
});

// Closed-policy cases are grouped to keep their shared representative input explicit.
// oxlint-disable-next-line max-lines-per-function
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

  it("rejects validation commands above the closed policy ceilings", async () => {
    const invalidPolicies = [
      {
        ...effectivePolicy,
        verification: {
          validationCommands: Array.from({ length: 11 }, () => ({
            argv: ["npm", "test"],
            timeoutSeconds: 30,
          })),
        },
      },
      {
        ...effectivePolicy,
        verification: {
          validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 601 }],
        },
      },
      {
        ...effectivePolicy,
        verification: {
          validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 30, shell: true }],
        },
      },
    ];

    const outcomes = await Promise.all(
      invalidPolicies.map((policy) =>
        runReview({
          ...representativePullRequest,
          policy: {
            ...representativePullRequest.policy,
            contents: JSON.stringify(policy),
          },
        }),
      ),
    );
    expect(outcomes.map(({ type }) => type)).toEqual([
      "configuration_failure",
      "configuration_failure",
      "configuration_failure",
    ]);
  });

  it("rejects unpinned patch sandboxes and invalid validation-rule references", async () => {
    const invalidPatchConfigurations = [
      {
        sandboxImage: "node:latest",
        validationRules: [{ includePaths: ["src/**"], commandIndex: 0 }],
      },
      {
        sandboxImage: `node@sha256:${"a".repeat(64)}`,
        validationRules: [{ includePaths: ["src/**"], commandIndex: 1 }],
      },
    ];
    const outcomes = await Promise.all(
      invalidPatchConfigurations.map((suggestedPatches) =>
        runReview({
          ...representativePullRequest,
          policy: {
            ...representativePullRequest.policy,
            contents: JSON.stringify({
              ...effectivePolicy,
              verification: {
                validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 30 }],
                suggestedPatches,
              },
            }),
          },
        }),
      ),
    );

    expect(outcomes).toEqual([
      expect.objectContaining({
        type: "configuration_failure",
        reason:
          "Project policy verification.suggestedPatches.sandboxImage must be a digest-pinned image.",
      }),
      expect.objectContaining({
        type: "configuration_failure",
        reason: expect.stringContaining("commandIndex must reference a validation command"),
      }),
    ]);
  });

  it("rejects a validation timeout longer than the complete review timeout", async () => {
    const outcome = await runReview(
      {
        ...representativePullRequest,
        policy: {
          ...representativePullRequest.policy,
          contents: JSON.stringify({
            ...effectivePolicy,
            limits: { ...effectivePolicy.limits, reviewTimeoutSeconds: 20 },
            verification: {
              validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 21 }],
            },
          }),
        },
      },
      { credentialProfiles: { primary: { type: "env" } } },
    );

    expect(outcome).toMatchObject({
      type: "configuration_failure",
      reason:
        "Project policy verification.validationCommands[0].timeoutSeconds exceeds limits.reviewTimeoutSeconds of 20.",
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
