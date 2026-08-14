/* oxlint-disable max-lines */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, expect, it } from "vitest";

import { createActionIo, runAction } from "../src/action.js";
import { actionExitCodeForOutcome } from "../src/action-readiness.js";
import { PublicationRefusalError } from "../src/github-publication.js";
import {
  FileSystemReviewPersistenceStore,
  findingIdentityMarker,
  type RoleExecutionRequest,
} from "../src/review-engine.js";
import { persistedRunCount, temporaryStateDirectories } from "./persistence-fixtures.js";
import {
  completedReviewOutcome,
  emptyRoleResult,
  materialAssessment,
  projectPolicy,
  pullRequestEvent,
  reviewedPullRequest,
  roleArtifact,
  trustedSameRepoTrust,
  verifierResult,
} from "./review-fixtures.js";

const eventPath = fileURLToPath(
  new URL("./fixtures/github-pull-request-event.json", import.meta.url),
);

const representativePolicy = JSON.stringify(projectPolicy());
const stateDirectories = temporaryStateDirectories("diffowl-action-state-");

afterEach(stateDirectories.removeAll);

const representativeDiff = [
  "diff --git a/src/message.ts b/src/message.ts",
  "index ce01362..94954ab 100644",
  "--- a/src/message.ts",
  "+++ b/src/message.ts",
  "@@ -1 +1 @@",
  "-hello",
  "+hello owl",
  "",
].join("\n");

const passingValidationPolicy = JSON.stringify(
  projectPolicy({
    verification: {
      validationCommands: [
        { argv: [process.execPath, "-e", "process.stdout.write('passed')"], timeoutSeconds: 5 },
      ],
    },
  }),
);

type CapturedValidation = {
  validationAttempts?: Array<{ status: string; limitation?: string; stdout?: string }>;
};

async function validationAttemptsForRunner(
  runnerEnvironment: string | undefined,
): Promise<CapturedValidation["validationAttempts"]> {
  let verifierInput: CapturedValidation | undefined;
  await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      RUNNER_ENVIRONMENT: runnerEnvironment,
    },
    {
      readFile,
      readDiff: async () => representativeDiff,
      readPolicy: async () => passingValidationPolicy,
      setOutput: async () => undefined,
      executeRole: async (request) => {
        if (request.step.role === "verifier")
          verifierInput = request.roleInput as CapturedValidation;
        return emptyRoleResult(request);
      },
    },
  );
  return verifierInput?.validationAttempts;
}

function materialRoleResult(request: RoleExecutionRequest) {
  if (request.step.role === "reviewer") {
    return {
      type: "completed" as const,
      output: {
        role: "reviewer" as const,
        candidateFindings: [
          {
            summary: "Public greeting can be empty",
            location: { path: "src/message.ts", line: 1 },
            impact: "Callers receive an invalid response.",
            evidence: ["return greeting ?? ''"],
            fingerprintContext: {
              claimKind: "invalid-return",
              affectedArea: "greeting API",
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
      type: "completed" as const,
      output: {
        role: "challenger" as const,
        assessments: [{ candidateIndex: 0, verdict: "support" as const, reason: "supported" }],
      },
      artifact: roleArtifact("challenger"),
    };
  }
  return verifierResult([materialAssessment(["scoped-diff"], "verified")]);
}

function capturingActionIo(outputs: Map<string, string>) {
  return {
    readFile,
    readDiff: async () => representativeDiff,
    readPolicy: async () => representativePolicy,
    setOutput: async (name: string, value: string) => {
      outputs.set(name, value);
    },
    executeRole: async (request: RoleExecutionRequest) => emptyRoleResult(request),
  };
}

// The adapter contract is intentionally asserted in one integration-style example.
// oxlint-disable-next-line max-lines-per-function
it("supplies an environment credential profile to the Review engine", async () => {
  const outputs = new Map<string, string>();
  let execution: RoleExecutionRequest | undefined;

  const outcome = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
    },
    {
      readFile,
      readDiff: async (baseSha, headSha) => {
        expect(baseSha).toBe(reviewedPullRequest.baseSha);
        expect(headSha).toBe(reviewedPullRequest.headSha);
        return representativeDiff;
      },
      readPolicy: async (revision, path) => {
        expect(revision).toBe(reviewedPullRequest.baseSha);
        expect(path).toBe(".diffowl.json");
        return representativePolicy;
      },
      setOutput: async (name, value) => {
        outputs.set(name, value);
      },
      credentialProfiles: { default: { type: "env" } },
      executeRole: async (request) => {
        execution ??= request;
        return emptyRoleResult(request);
      },
    },
  );

  expect(execution).toMatchObject({
    step: { role: "reviewer", purpose: "generate_candidates" },
    credentials: { type: "env" },
  });
  expect(outcome).toEqual(
    completedReviewOutcome({
      trust: trustedSameRepoTrust,
      policy: projectPolicy(),
      policySource: {
        type: "trusted_base_branch",
        revision: reviewedPullRequest.baseSha,
        path: ".diffowl.json",
      },
      verification: {
        evidenceCatalog: [
          {
            id: "scoped-diff",
            type: "scoped_diff",
            path: "pull-request.diff",
            content: representativeDiff,
            truncated: false,
          },
        ],
        validationAttempts: [],
        limitations: [],
        coverageGaps: [],
      },
    }),
  );
  expect(JSON.parse(outputs.get("outcome") ?? "")).toEqual(outcome);
});

it("persists Action runs and publishes safe run outputs", async () => {
  const stateDirectory = await stateDirectories.create();
  const outputs = new Map<string, string>();

  const invoke = () =>
    runAction(
      {
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        "INPUT_STATE-DIRECTORY": stateDirectory,
      },
      {
        readFile,
        readDiff: async () => representativeDiff,
        readPolicy: async () => representativePolicy,
        setOutput: async (name, value) => {
          outputs.set(name, value);
        },
        executeRole: async (request) => emptyRoleResult(request),
      },
    );
  await invoke();
  await invoke();

  expect(outputs.get("run-id")).toBeTruthy();
  expect(JSON.parse(outputs.get("run-metadata") ?? "")).toMatchObject({ recordVersion: 1 });
  expect(await persistedRunCount(stateDirectory)).toBe(2);
});

it("applies author Finding discussion replies from the Action adapter", async () => {
  const stateDirectory = await stateDirectories.create();
  const event = JSON.stringify(pullRequestEvent({ actor: "author" }));
  let fingerprint = "";
  const baseIo = {
    readFile: async () => event,
    readDiff: async () => representativeDiff,
    readPolicy: async () => representativePolicy,
    setOutput: async () => undefined,
  };

  const first = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      INPUT_STATE_DIRECTORY: stateDirectory,
    },
    { ...baseIo, executeRole: async (request) => materialRoleResult(request) },
  );
  fingerprint = first.type === "findings" ? first.materialFindings[0].fingerprint.value : "";

  const second = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      INPUT_STATE_DIRECTORY: stateDirectory,
    },
    {
      ...baseIo,
      listFindingDiscussionComments: async () => [
        {
          id: 10,
          actor: "author",
          body: "/review-owl resolved fixed in latest push",
          createdAt: "2026-01-01T00:00:00.000Z",
          threadBody: findingIdentityMarker(fingerprint),
        },
        {
          id: 11,
          actor: "reviewer",
          body: "/review-owl rebut not fixed",
          createdAt: "2026-01-01T00:00:01.000Z",
          threadBody: findingIdentityMarker(fingerprint),
        },
      ],
      executeRole: async (request) => emptyRoleResult(request),
    },
  );

  expect(second.run?.ledgerTransitions).toEqual([
    expect.objectContaining({ fingerprint, lifecycleState: "resolved" }),
  ]);
});

it("publishes, reports, and persists adapter-owned receipts when a publisher is injected", async () => {
  const stateDirectory = await stateDirectories.create();
  const outputs = new Map<string, string>();
  const calls: Array<{ repository: string; pullRequestNumber: number; headSha: string }> = [];
  const result = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      INPUT_STATE_DIRECTORY: stateDirectory,
    },
    {
      ...capturingActionIo(outputs),
      publishOutcome: async (target, outcome, authorization) => {
        calls.push(target);
        expect(outcome.type).toBe("clean");
        expect(authorization).toEqual({
          sourceRunVerified: true,
          surfaces: ["pull_request_review"],
        });
        return {
          result: "complete",
          headSha: target.headSha,
          inlineCommentCount: 0,
          unanchoredFindingCount: 0,
        };
      },
    },
  );

  expect(calls).toEqual([
    {
      repository: reviewedPullRequest.repository,
      pullRequestNumber: reviewedPullRequest.number,
      headSha: reviewedPullRequest.headSha,
      changedLines: [{ path: "src/message.ts", line: 1 }],
    },
  ]);
  expect(JSON.parse(outputs.get("outcome") ?? "")).toEqual(result);
  const receipt = {
    result: "complete",
    headSha: reviewedPullRequest.headSha,
    inlineCommentCount: 0,
    unanchoredFindingCount: 0,
  };
  expect(JSON.parse(outputs.get("publication") ?? "")).toEqual(receipt);
  await new FileSystemReviewPersistenceStore(stateDirectory).withTransaction(
    { repository: reviewedPullRequest.repository, pullRequestNumber: reviewedPullRequest.number },
    async (transaction) => {
      expect(await transaction.loadPublicationEffects(result.run?.runId ?? "missing")).toEqual(
        receipt,
      );
    },
  );
});

it("maps non-clean Review outcomes to a failing workflow check", () => {
  const clean = { type: "clean", trust: trustedSameRepoTrust };
  expect(actionExitCodeForOutcome(clean as never)).toBe(0);
  expect(
    actionExitCodeForOutcome({
      type: "provider_failure",
      reason: "provider failed",
      trust: trustedSameRepoTrust,
      pullRequest: reviewedPullRequest,
      policy: {
        source: { type: "trusted_base_branch", revision: "base", path: ".diffowl.json" },
        effective: projectPolicy(),
      },
      executionArtifacts: [],
    } as never),
  ).toBe(1);
});

it("removes GITHUB_TOKEN from the engine environment while retaining a publisher", () => {
  const env = { GITHUB_TOKEN: "publisher-secret", GITHUB_OUTPUT: "output" };
  const io = createActionIo(env);
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(io.publishOutcome).toBeTypeOf("function");
});

async function publicationFailureOutputs(error: Error) {
  const outputs = new Map<string, string>();
  await expect(
    runAction(
      { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
      {
        ...capturingActionIo(outputs),
        publishOutcome: async () => {
          throw error;
        },
      },
    ),
  ).rejects.toThrow("Refusing to publish");
  expect(JSON.parse(outputs.get("outcome") ?? "{}")).toMatchObject({ type: "clean" });
  return JSON.parse(outputs.get("publication") ?? "{}");
}

it("reports publication denial as a separate incomplete publication", async () => {
  await expect(
    publicationFailureOutputs(
      new Error("Refusing to publish an invalid, oversized, or stale Review outcome."),
    ),
  ).resolves.toEqual({
    result: "incomplete",
    reason: "Refusing to publish an invalid, oversized, or stale Review outcome.",
  });
});

it("records publication as refused when publication validation rejects", async () => {
  await expect(publicationFailureOutputs(new PublicationRefusalError())).resolves.toEqual({
    result: "refused",
    reason: "Refusing to publish an invalid, oversized, or stale Review outcome.",
  });
});

it("records publication as not attempted when no publisher is configured", async () => {
  const outputs = new Map<string, string>();
  await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
    capturingActionIo(outputs),
  );
  expect(outputs.has("outcome")).toBe(true);
  expect(JSON.parse(outputs.get("publication") ?? "{}")).toEqual({ result: "not_attempted" });
});

it("records validation as unavailable by default on unknown and self-hosted runners", async () => {
  const attempts = await Promise.all([undefined, "self-hosted"].map(validationAttemptsForRunner));

  for (const attempt of attempts) {
    expect(attempt).toEqual([
      expect.objectContaining({
        status: "error",
        limitation: "No validation execution adapter was configured.",
      }),
    ]);
  }
});

it("executes configured validation by default on a GitHub-hosted runner", async () => {
  const attempts = await validationAttemptsForRunner("github-hosted");

  expect(attempts).toEqual([expect.objectContaining({ status: "passed", stdout: "passed" })]);
});

it("denies risky capabilities and publishing for a fork pull request", async () => {
  const event = pullRequestEvent({
    headRepository: "contributor/review-target",
    actor: "contributor",
  });
  let published = false;

  const outcome = await runAction(
    {
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: "event.json",
      GITHUB_TOKEN: "must-not-be-used",
    },
    {
      readFile: async () => JSON.stringify(event),
      readDiff: async () => representativeDiff,
      readPolicy: async () => representativePolicy,
      setOutput: async () => undefined,
      publishOutcome: async () => {
        published = true;
        throw new Error("untrusted outcome must not publish");
      },
    },
  );

  expect(published).toBe(false);
  expect(outcome).toMatchObject({
    type: "partial_coverage",
    reason: "Trust restrictions permit static review only; validation commands are denied.",
    trust: {
      class: "untrusted_pull_request",
      source: "fork",
      capabilities: {
        validationCommands: "denied",
        secrets: "denied",
        writeTokens: "denied",
        privilegedTools: "denied",
        publishing: "denied",
      },
    },
  });
});

it("treats Dependabot as untrusted and does not publish", async () => {
  const event = pullRequestEvent({ actor: "dependabot[bot]" });
  let published = false;
  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "event.json" },
    {
      ...capturingActionIo(new Map()),
      readFile: async () => JSON.stringify(event),
      publishOutcome: async () => {
        published = true;
        throw new Error("Dependabot outcome must not publish");
      },
    },
  );

  expect(published).toBe(false);
  expect(outcome).toMatchObject({
    type: "partial_coverage",
    reason: "Trust restrictions permit static review only; validation commands are denied.",
    trust: { class: "untrusted_pull_request", source: "dependabot" },
  });
});

it("skips pull_request_target before reading the event payload", async () => {
  let eventRead = false;

  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: "event.json" },
    {
      readFile: async () => {
        eventRead = true;
        return "{}";
      },
      readDiff: async () => representativeDiff,
      readPolicy: async () => representativePolicy,
      setOutput: async () => undefined,
    },
  );

  expect(eventRead).toBe(false);
  expect(outcome).toMatchObject({
    type: "policy_skip",
    trust: { class: "unsafe_or_unsupported" },
  });
});

it("reports unsupported pull-request shapes before reading repository content", async () => {
  let repositoryRead = false;
  const outputs = new Map<string, string>();

  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "event.json" },
    {
      readFile: async () => JSON.stringify({ action: "push" }),
      readDiff: async () => {
        repositoryRead = true;
        return representativeDiff;
      },
      readPolicy: async () => {
        repositoryRead = true;
        return representativePolicy;
      },
      setOutput: async (name, value) => {
        outputs.set(name, value);
      },
    },
  );

  expect(repositoryRead).toBe(false);
  expect(outcome).toEqual({
    type: "unsupported_change",
    reason: "The GitHub event is not a supported pull-request event.",
    trust: {
      class: "unsafe_or_unsupported",
      reason: "The GitHub event is not a supported pull-request event.",
      capabilities: {
        validationCommands: "denied",
        secrets: "denied",
        writeTokens: "denied",
        privilegedTools: "denied",
        publishing: "denied",
      },
    },
  });
  expect(JSON.parse(outputs.get("outcome") ?? "{}")).toEqual(outcome);
  expect(JSON.parse(outputs.get("publication") ?? "{}")).toEqual({ result: "not_attempted" });
});

it("skips an unsafe pull-request identity before reading repository content", async () => {
  let repositoryRead = false;
  const event = {
    repository: { full_name: "example/review-target" },
    pull_request: {
      number: 42,
      base: {
        sha: reviewedPullRequest.baseSha,
        repo: { full_name: "attacker/review-target" },
      },
      head: {
        sha: reviewedPullRequest.headSha,
        repo: { full_name: "attacker/review-target" },
      },
    },
  };

  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "event.json" },
    {
      readFile: async () => JSON.stringify(event),
      readDiff: async () => {
        repositoryRead = true;
        return representativeDiff;
      },
      readPolicy: async () => {
        repositoryRead = true;
        return representativePolicy;
      },
      setOutput: async () => undefined,
    },
  );

  expect(repositoryRead).toBe(false);
  expect(outcome).toMatchObject({
    type: "policy_skip",
    trust: { class: "unsafe_or_unsupported" },
  });
});
