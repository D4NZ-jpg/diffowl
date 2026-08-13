import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

import { runAction } from "../src/action.js";

const eventPath = fileURLToPath(
  new URL("./fixtures/github-pull-request-event.json", import.meta.url),
);

const representativePolicy = JSON.stringify({
  version: 1,
  scope: { includePaths: ["src/**"], excludePaths: ["dist/**"] },
  limits: { reviewTimeoutSeconds: 600, maxFindings: 25 },
});

const representativeDiff = [
  "diff --git a/message.txt b/message.txt",
  "index ce01362..94954ab 100644",
  "--- a/message.txt",
  "+++ b/message.txt",
  "@@ -1 +1 @@",
  "-hello",
  "+hello owl",
  "",
].join("\n");

it("runs the Review engine for a same-repo pull request", async () => {
  const outputs = new Map<string, string>();

  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath },
    {
      readFile,
      readDiff: async (baseSha, headSha) => {
        expect(baseSha).toBe("1111111111111111111111111111111111111111");
        expect(headSha).toBe("2222222222222222222222222222222222222222");
        return representativeDiff;
      },
      readPolicy: async (revision, path) => {
        expect(revision).toBe("1111111111111111111111111111111111111111");
        expect(path).toBe(".diffowl.json");
        return representativePolicy;
      },
      setOutput: async (name, value) => {
        outputs.set(name, value);
      },
    },
  );

  expect(outcome).toEqual({
    type: "partial_coverage",
    pullRequest: {
      repository: "example/review-target",
      number: 42,
      baseSha: "1111111111111111111111111111111111111111",
      headSha: "2222222222222222222222222222222222222222",
    },
    reason: "The tracer path does not analyze changes yet.",
    trust: {
      class: "trusted_same_repo_pull_request",
      capabilities: {
        validationCommands: "sandboxed",
        secrets: "denied",
        writeTokens: "denied",
        privilegedTools: "denied",
        publishing: "denied",
      },
    },
    policy: {
      source: {
        type: "trusted_base_branch",
        revision: "1111111111111111111111111111111111111111",
        path: ".diffowl.json",
      },
      effective: JSON.parse(representativePolicy),
    },
  });
  expect(JSON.parse(outputs.get("outcome") ?? "")).toEqual(outcome);
});

it("denies risky capabilities for a fork pull request", async () => {
  const event = {
    repository: { full_name: "example/review-target" },
    pull_request: {
      number: 42,
      base: {
        sha: "1111111111111111111111111111111111111111",
        repo: { full_name: "example/review-target" },
      },
      head: {
        sha: "2222222222222222222222222222222222222222",
        repo: { full_name: "contributor/review-target" },
      },
      user: { login: "contributor" },
    },
  };

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
  const event = {
    repository: { full_name: "example/review-target" },
    pull_request: {
      number: 42,
      base: {
        sha: "1111111111111111111111111111111111111111",
        repo: { full_name: "example/review-target" },
      },
      head: {
        sha: "2222222222222222222222222222222222222222",
        repo: { full_name: "example/review-target" },
      },
      user: { login: "dependabot[bot]" },
    },
  };

  const outcome = await runAction(
    { GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "event.json" },
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
        sha: "1111111111111111111111111111111111111111",
        repo: { full_name: "attacker/review-target" },
      },
      head: {
        sha: "2222222222222222222222222222222222222222",
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
