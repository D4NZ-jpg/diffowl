import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import type { RoleExecutionRequest } from "../src/review-engine.js";
import { completedReviewOutcome, emptyRoleResult, projectPolicy } from "./review-fixtures.js";

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
      executeRole: async (request) => {
        execution ??= request;
        return emptyRoleResult(request);
      },
    });

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(execution).toMatchObject({
      step: { role: "reviewer", purpose: "generate_candidates" },
      credentials: "local",
    });
    expect(JSON.parse(stdout)).toEqual(
      completedReviewOutcome({
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
        policy: projectPolicy(),
        policySource: { type: "local_invocation", path: policyPath },
        verification: {
          evidenceCatalog: [],
          validationAttempts: [],
          limitations: ["The configured review scope produced an empty diff."],
        },
      }),
    );
  });
});
