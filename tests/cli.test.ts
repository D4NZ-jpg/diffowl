import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import type { RoleExecutionRequest } from "../src/review-engine.js";

const fixturePath = fileURLToPath(new URL("./fixtures/pull-request.json", import.meta.url));
const policyPath = fileURLToPath(new URL("./fixtures/project-policy.json", import.meta.url));

// The suite has one integration-style example that asserts the complete CLI contract.
// oxlint-disable-next-line max-lines-per-function
describe("diffowl review", () => {
  // oxlint-disable-next-line max-lines-per-function
  it("supplies local credentials to the Review engine", async () => {
    let stdout = "";
    let stderr = "";
    let execution: RoleExecutionRequest | undefined;

    const exitCode = await runCli(["review", "--input", fixturePath, "--policy", policyPath], {
      readFile,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      credentialProfiles: { default: "local" },
      executeRoles: async (request) => {
        execution = request;
        return { type: "completed" };
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(execution).toMatchObject({
      roles: {
        reviewer: { credentials: "local" },
        challenger: { credentials: "local" },
        verifier: { credentials: "local" },
      },
    });
    expect(JSON.parse(stdout)).toEqual({
      type: "partial_coverage",
      pullRequest: {
        repository: "example/review-target",
        number: 42,
        baseSha: "1111111111111111111111111111111111111111",
        headSha: "2222222222222222222222222222222222222222",
      },
      reason: "The tracer path does not analyze changes yet.",
      trust: {
        class: "local_cli",
        capabilities: {
          validationCommands: "local_user_authorized",
          secrets: "local_user_authorized",
          writeTokens: "local_user_authorized",
          privilegedTools: "local_user_authorized",
          publishing: "denied",
        },
      },
      policy: {
        source: {
          type: "local_invocation",
          path: policyPath,
        },
        effective: {
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
              credentialProfile: "default",
            },
            challenger: {
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              credentialProfile: "default",
            },
            verifier: {
              provider: "openai",
              model: "gpt-5-mini",
              credentialProfile: "default",
            },
          },
        },
      },
    });
  });
});
