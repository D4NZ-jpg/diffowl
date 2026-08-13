/* oxlint-disable max-lines */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { runAction } from "../src/action.js";
import type { RoleExecutionRequest } from "../src/review-engine.js";
import {
  completedReviewOutcome,
  emptyRoleResult,
  projectPolicy,
  pullRequestEvent,
  reviewedPullRequest,
  trustedSameRepoTrust,
} from "./review-fixtures.js";

const eventPath = fileURLToPath(
  new URL("./fixtures/github-pull-request-event.json", import.meta.url),
);

const representativePolicy = JSON.stringify(projectPolicy());

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

async function actionOutcomeForEvent(event: Record<string, unknown>) {
  return runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "event.json" },
    {
      readFile: async () => JSON.stringify(event),
      readDiff: async () => representativeDiff,
      readPolicy: async () => representativePolicy,
      setOutput: async () => undefined,
    },
  );
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
      },
    }),
  );
  expect(JSON.parse(outputs.get("outcome") ?? "")).toEqual(outcome);
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

it("denies risky capabilities for a fork pull request", async () => {
  const event = pullRequestEvent({
    headRepository: "contributor/review-target",
    actor: "contributor",
  });

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
    },
  );

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

it("treats Dependabot as untrusted even when its branch is in the repository", async () => {
  const event = pullRequestEvent({ actor: "dependabot[bot]" });

  const outcome = await actionOutcomeForEvent(event);

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

it("skips unsupported events before reading repository content", async () => {
  let repositoryRead = false;
  let output = "";

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
      setOutput: async (_name, value) => {
        output = value;
      },
    },
  );

  expect(repositoryRead).toBe(false);
  expect(outcome).toEqual({
    type: "policy_skip",
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
  expect(JSON.parse(output)).toEqual(outcome);
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
