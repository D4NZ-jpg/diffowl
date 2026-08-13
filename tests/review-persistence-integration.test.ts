/* oxlint-disable max-lines */
import { describe, expect, it } from "vitest";

import {
  type FindingLedger,
  type PullRequestInput,
  type ReviewPersistenceStore,
  type ReviewPersistenceTransaction,
  type ReviewRunRecord,
  type RoleExecutionRequest,
  type RoleExecutionResult,
  runReview,
} from "../src/review-engine.js";
import {
  emptyRoleResult,
  reviewedPullRequest,
  roleArtifact,
  trustedSameRepoTrust,
} from "./review-fixtures.js";

class MemoryPersistence implements ReviewPersistenceStore {
  ledger?: FindingLedger;
  records: ReviewRunRecord[] = [];

  async withTransaction<T>(
    _key: { repository: string; pullRequestNumber: number },
    operation: (transaction: ReviewPersistenceTransaction) => Promise<T>,
  ): Promise<T> {
    const transaction: ReviewPersistenceTransaction = {
      loadLedger: async () => this.ledger,
      saveLedger: async (ledger) => {
        this.ledger = ledger;
      },
      saveRunRecord: async (record) => {
        this.records.push(record);
      },
      loadRunRecord: async (runId) => this.records.find((record) => record.runId === runId),
    };
    return operation(transaction);
  }
}

const policy = {
  version: 1,
  scope: { includePaths: ["src/**"], excludePaths: [] },
  limits: { reviewTimeoutSeconds: 60, maxFindings: 10 },
  verification: { validationCommands: [] },
  roleProfiles: {
    reviewer: { provider: "safe-provider", model: "safe-model", credentialProfile: "primary" },
    challenger: { provider: "safe-provider", model: "safe-model", credentialProfile: "primary" },
    verifier: { provider: "safe-provider", model: "safe-model", credentialProfile: "primary" },
  },
};

function input(line: number): PullRequestInput {
  return {
    ...reviewedPullRequest,
    headSha: `${line}`.padStart(40, "2").slice(0, 40),
    diff: `diff --git a/src/message.ts b/src/message.ts\n@@ -${line} +${line} @@\n-old\n+new`,
    trust: trustedSameRepoTrust,
    policy: {
      source: {
        type: "trusted_base_branch",
        revision: reviewedPullRequest.baseSha,
        path: ".diffowl.json",
      },
      contents: JSON.stringify(policy),
    },
  };
}

function findingRoles(
  disposition: "material" | "suppress" = "material",
  options: { summary?: string; affectedArea?: string } = {},
) {
  return async (request: RoleExecutionRequest): Promise<RoleExecutionResult> => {
    if (request.step.role === "reviewer") {
      return {
        type: "completed",
        output: {
          role: "reviewer",
          candidateFindings: [
            {
              summary: options.summary ?? "Public greeting can be empty",
              location: {
                path: "src/message.ts",
                line: request.pullRequest.headSha === reviewedPullRequest.headSha ? 1 : 99,
              },
              impact: "Callers receive an invalid response.",
              evidence: ["return greeting ?? ''"],
              fingerprintContext: {
                claimKind: "invalid-return",
                affectedArea: options.affectedArea ?? "greeting API",
                policyOrCapability: "runtime correctness",
                symbol: "greeting",
              },
            },
          ],
          advisorySuggestions: [],
        },
        artifact: roleArtifact("reviewer"),
      };
    }
    if (request.step.role === "challenger") {
      return {
        type: "completed",
        output: {
          role: "challenger",
          assessments: [{ candidateIndex: 0, verdict: "support", reason: "supported" }],
        },
        artifact: roleArtifact("challenger"),
      };
    }
    return {
      type: "completed",
      output: {
        role: "verifier",
        assessments: [
          {
            candidateIndex: 0,
            disposition,
            evidenceIds: ["scoped-diff"],
            explanation: "verified",
            limitations: [],
          },
        ],
      },
      artifact: roleArtifact("verifier"),
    };
  };
}

const dependencies = (store: MemoryPersistence, runId: string) => ({
  persistence: store,
  runId,
  engineVersion: "test-engine",
  recordedAt: () => "2026-01-01T00:00:00.000Z",
  credentialProfiles: { primary: { type: "env" as const } },
});

const passingVerificationAdapter = {
  readRepositoryFile: async () => undefined,
  executeValidation: async () => ({
    status: "passed" as const,
    exitCode: 0,
    stdout: "ok",
    stderr: "",
    truncated: false,
  }),
};

function duplicateFindingRoles(disposition: "material" | "suppress") {
  return async (request: RoleExecutionRequest): Promise<RoleExecutionResult> => {
    const result = await findingRoles(disposition === "suppress" ? "suppress" : "material")(
      request,
    );
    if (result.type !== "completed") return result;
    if (result.output.role === "reviewer") {
      result.output.candidateFindings.push(structuredClone(result.output.candidateFindings[0]!));
    } else if (result.output.role === "challenger") {
      result.output.assessments.push({
        candidateIndex: 1,
        verdict: "support",
        reason: "supported",
      });
    } else {
      result.output.assessments.push({
        candidateIndex: 1,
        disposition,
        evidenceIds: disposition === "material" ? ["scoped-diff"] : [],
        explanation: `${disposition} again`,
        limitations: [],
      });
    }
    return result;
  };
}

// oxlint-disable-next-line max-lines-per-function
describe("runReview persistence integration", () => {
  it("reconciles new, persisting, and resolved across line movement", async () => {
    const store = new MemoryPersistence();
    const first = await runReview(input(1), {
      ...dependencies(store, "run-1"),
      executeRole: findingRoles(),
    });
    const second = await runReview(input(99), {
      ...dependencies(store, "run-2"),
      executeRole: findingRoles(),
    });
    const third = await runReview(input(100), {
      ...dependencies(store, "run-3"),
      executeRole: async (request) => emptyRoleResult(request),
    });

    expect(first.type === "findings" ? first.materialFindings[0].lifecycleState : "").toBe("new");
    expect(second.type === "findings" ? second.materialFindings[0].lifecycleState : "").toBe(
      "persisting",
    );
    expect(store.records[1]?.finalOutcome.materialFindings?.[0]?.lifecycleState).toBe("persisting");
    expect(
      first.type === "findings" && second.type === "findings"
        ? second.materialFindings[0].fingerprint.value ===
            first.materialFindings[0].fingerprint.value
        : false,
    ).toBe(true);
    expect(third.run?.ledgerTransitions).toEqual([
      expect.objectContaining({ lifecycleState: "resolved" }),
    ]);
  });

  it("keeps incomplete reviews partial and preserves unseen active findings", async () => {
    const store = new MemoryPersistence();
    await runReview(input(8), { ...dependencies(store, "run-prior"), executeRole: findingRoles() });
    const configuredPolicy = {
      ...policy,
      verification: { validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 10 }] },
    };
    const partial = await runReview(
      { ...input(9), policy: { ...input(9).policy, contents: JSON.stringify(configuredPolicy) } },
      {
        ...dependencies(store, "run-partial-with-finding"),
        executeRole: findingRoles("material", {
          summary: "Cache can skip authorization",
          affectedArea: "authorization cache",
        }),
        verificationAdapter: {
          readRepositoryFile: async () => undefined,
          executeValidation: async () => ({
            status: "error" as const,
            stdout: "",
            stderr: "",
            truncated: false,
            limitation: "Validation execution is unavailable.",
          }),
        },
      },
    );

    expect(partial.type).toBe("partial_coverage");
    expect(partial.type === "partial_coverage" ? partial.materialFindings : []).toHaveLength(1);
    expect(store.ledger?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ summary: "Public greeting can be empty", lifecycleState: "new" }),
        expect.objectContaining({ summary: "Cache can skip authorization", lifecycleState: "new" }),
      ]),
    );
    expect(store.records.at(-1)?.finalOutcome).toMatchObject({
      type: "partial_coverage",
      materialFindingCount: 1,
      materialFindings: [
        expect.objectContaining({ verificationState: "verified_with_limitations" }),
      ],
      ledgerTransitions: expect.arrayContaining([
        expect.objectContaining({ lifecycleState: "new", changed: false }),
        expect.objectContaining({ lifecycleState: "new", changed: true }),
      ]),
    });
  });

  it("applies accepted and rebutted dispositions and explicit reassessment", async () => {
    const store = new MemoryPersistence();
    const first = await runReview(input(1), {
      ...dependencies(store, "run-discovered"),
      executeRole: findingRoles(),
    });
    const fingerprint =
      first.type === "findings" ? first.materialFindings[0].fingerprint.value : "";
    await runReview(input(2), {
      ...dependencies(store, "run-accepted"),
      executeRole: findingRoles(),
      findingDispositions: { [fingerprint]: "accepted" },
    });
    expect(store.ledger?.entries[0]?.lifecycleState).toBe("accepted");
    expect(store.records.at(-1)?.finalOutcome.materialFindings?.[0]?.lifecycleState).toBe(
      "accepted",
    );
    await runReview(input(3), {
      ...dependencies(store, "run-rebutted"),
      executeRole: findingRoles(),
      findingDispositions: { [fingerprint]: "rebutted" },
    });
    expect(store.ledger?.entries[0]?.lifecycleState).toBe("rebutted");
    const reassessed = await runReview(input(4), {
      ...dependencies(store, "run-reassessed"),
      executeRole: findingRoles(),
      reassessedFingerprints: [fingerprint],
    });
    expect(
      reassessed.type === "findings" ? reassessed.materialFindings[0].lifecycleState : "",
    ).toBe("persisting");
  });

  it("deduplicates semantically identical material and suppressed candidates", async () => {
    const store = new MemoryPersistence();
    const outcome = await runReview(input(5), {
      ...dependencies(store, "run-duplicates"),
      executeRole: duplicateFindingRoles("material"),
    });
    expect(outcome.type === "findings" ? outcome.materialFindings : []).toHaveLength(1);
    expect(store.ledger?.entries).toHaveLength(1);
  });

  it("deduplicates semantically identical suppressed candidates", async () => {
    const store = new MemoryPersistence();
    await runReview(input(5), {
      ...dependencies(store, "run-suppressed-duplicates"),
      executeRole: duplicateFindingRoles("suppress"),
    });
    expect(store.ledger?.entries).toHaveLength(1);
    expect(store.ledger?.entries[0]?.lifecycleState).toBe("suppressed");
  });

  it("records verifier suppression without publishing a material finding", async () => {
    const store = new MemoryPersistence();
    const outcome = await runReview(input(2), {
      ...dependencies(store, "run-suppressed"),
      executeRole: findingRoles("suppress"),
    });

    expect(outcome.type).toBe("clean");
    expect(outcome.type === "clean" ? outcome.materialFindings : []).toEqual([]);
    expect(store.ledger?.entries).toEqual([
      expect.objectContaining({
        lifecycleState: "suppressed",
        summary: "Public greeting can be empty",
      }),
    ]);
  });

  it("persists validation attempts when the verifier provider fails", async () => {
    const store = new MemoryPersistence();
    const configuredPolicy = {
      ...policy,
      verification: {
        validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 10 }],
      },
    };
    const outcome = await runReview(
      { ...input(6), policy: { ...input(6).policy, contents: JSON.stringify(configuredPolicy) } },
      {
        ...dependencies(store, "run-validation-failure"),
        executeRole: async (request) => {
          if (request.step.role === "verifier") {
            return { type: "provider_failure", reason: "provider failed" };
          }
          return findingRoles()(request);
        },
        verificationAdapter: passingVerificationAdapter,
      },
    );
    expect(outcome.type).toBe("provider_failure");
    expect(store.records.at(-1)?.validationAttempts).toHaveLength(1);
  });

  it("persists completed and aborted attempts when timing out during validation", async () => {
    const store = new MemoryPersistence();
    const configuredPolicy = {
      ...policy,
      limits: { ...policy.limits, reviewTimeoutSeconds: 1 },
      verification: {
        validationCommands: [
          { argv: ["fast"], timeoutSeconds: 1 },
          { argv: ["slow"], timeoutSeconds: 1 },
        ],
      },
    };
    const outcome = await runReview(
      { ...input(7), policy: { ...input(7).policy, contents: JSON.stringify(configuredPolicy) } },
      {
        ...dependencies(store, "run-mid-validation-timeout"),
        executeRole: findingRoles(),
        verificationAdapter: {
          readRepositoryFile: async () => undefined,
          executeValidation: async ({ argv, signal }) => {
            if (argv[0] === "fast") {
              return { status: "passed", exitCode: 0, stdout: "ok", stderr: "", truncated: false };
            }
            return new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () =>
                  resolve({
                    status: "aborted",
                    stdout: "",
                    stderr: "",
                    truncated: false,
                    limitation: "aborted",
                  }),
                { once: true },
              );
            });
          },
        },
      },
    );
    expect(outcome.type).toBe("timeout");
    expect(store.records.at(-1)?.validationAttempts).toEqual([
      expect.objectContaining({ commandIndex: 0, status: "passed" }),
      expect.objectContaining({ commandIndex: 1, status: "aborted" }),
    ]);
  });

  it("persists validation attempts when the review times out after validation", async () => {
    const store = new MemoryPersistence();
    const configuredPolicy = {
      ...policy,
      limits: { ...policy.limits, reviewTimeoutSeconds: 1 },
      verification: { validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 1 }] },
    };
    const outcome = await runReview(
      { ...input(7), policy: { ...input(7).policy, contents: JSON.stringify(configuredPolicy) } },
      {
        ...dependencies(store, "run-validation-timeout"),
        executeRole: async (request) => {
          if (request.step.role !== "verifier") return findingRoles()(request);
          return new Promise(() => undefined);
        },
        verificationAdapter: passingVerificationAdapter,
      },
    );
    expect(outcome.type).toBe("timeout");
    expect(store.records.at(-1)?.validationAttempts).toHaveLength(1);
  });

  it("preserves active findings on provider failure and stores safe required record fields", async () => {
    const store = new MemoryPersistence();
    await runReview(input(3), { ...dependencies(store, "run-found"), executeRole: findingRoles() });
    const failure = await runReview(input(4), {
      ...dependencies(store, "run-failed"),
      executeRole: async () => ({
        type: "provider_failure",
        reason: "secret token abc",
        artifact: undefined,
      }),
    });

    expect(failure.type).toBe("provider_failure");
    expect(store.ledger?.entries[0]?.lifecycleState).toBe("new");
    expect(store.records.at(-1)).toMatchObject({
      version: 1,
      runId: "run-failed",
      engineVersion: "test-engine",
      revision: { pullRequest: { repository: reviewedPullRequest.repository } },
      trustClass: "trusted_same_repo_pull_request",
      policyStatus: "valid",
      policyHash: expect.stringMatching(/^sha256:/),
      providerModels: expect.arrayContaining([
        expect.objectContaining({ provider: "safe-provider", model: "safe-model" }),
      ]),
      budget: { reviewTimeoutSeconds: 60, maxFindings: 10 },
      finalOutcome: { type: "provider_failure", diagnosticPresent: true },
    });
    expect(JSON.stringify(store.records.at(-1))).not.toContain("secret token abc");
  });

  it("never returns clean when persistence fails", async () => {
    const outcome = await runReview(input(5), {
      ...dependencies(new MemoryPersistence(), "run-error"),
      persistence: {
        withTransaction: async () => {
          throw new Error("disk full");
        },
      },
      executeRole: async (request) => emptyRoleResult(request),
    });
    expect(outcome).toMatchObject({
      type: "internal_failure",
      reason: "Review persistence failed; the result cannot be treated as clean.",
    });
  });
});
