import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import type { RoleExecutionRequest } from "../src/review-engine.js";
import { persistedRunCount, temporaryStateDirectories } from "./persistence-fixtures.js";
import { completedReviewOutcome, emptyRoleResult, projectPolicy } from "./review-fixtures.js";

const fixturePath = fileURLToPath(new URL("./fixtures/pull-request.json", import.meta.url));
const policyPath = fileURLToPath(new URL("./fixtures/project-policy.json", import.meta.url));
const stateDirectories = temporaryStateDirectories("diffowl-cli-state-");

async function invokeCli(args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const exitCode = await runCli(args, {
    readFile,
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
    credentialProfiles: { default: "local" },
    executeRole: async (request) => emptyRoleResult(request),
  });
  return { exitCode, stdout, stderr };
}

afterEach(stateDirectories.removeAll);

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
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      adapter: "local_cli",
      mode: "dry-run",
      ciTrusted: false,
      publishing: {
        requested: false,
        status: "not_attempted",
      },
      findings: [],
      advisorySuggestions: [],
      diagnostics: {
        outcomeType: "clean",
        validationAttemptCount: 0,
        providerArtifactCount: 3,
      },
    });
    expect(report.outcome).toEqual(
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
          coverageGaps: [],
        },
      }),
    );
  });

  it("labels explicit publishing mode as local and untrusted", async () => {
    const { exitCode, stdout } = await invokeCli([
      "review",
      "--input",
      fixturePath,
      "--policy",
      policyPath,
      "--publish",
    ]);

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      mode: "publish",
      ciTrusted: false,
      trust: { class: "local_cli", capabilities: { publishing: "denied" } },
      publishing: { requested: true, status: "not_attempted" },
    });
  });

  it("persists Review runs across CLI invocations", async () => {
    const stateDirectory = await stateDirectories.create();
    const args = [
      "review",
      "--input",
      fixturePath,
      "--policy",
      policyPath,
      "--state-directory",
      stateDirectory,
    ];
    const outcomes: Array<Record<string, unknown>> = [];

    const invoke = async () => {
      const { exitCode, stdout } = await invokeCli(args);
      expect(exitCode).toBe(0);
      const report = JSON.parse(stdout) as Record<string, unknown>;
      expect(report).toMatchObject({
        adapter: "local_cli",
        diagnostics: { ledgerEntryCount: 0 },
        ledger: { version: 1, entries: [] },
        runRecord: { version: 1, trustClass: "local_cli" },
      });
      outcomes.push(report.outcome as Record<string, unknown>);
    };
    await invoke();
    await invoke();

    const [first, second] = outcomes as [
      { run: { runId: string; recordVersion: number } },
      { run: { runId: string; recordVersion: number } },
    ];
    expect(first.run).toMatchObject({ recordVersion: 1 });
    expect(second.run).toMatchObject({ recordVersion: 1 });
    expect(first.run.runId).not.toBe(second.run.runId);
    expect(await persistedRunCount(stateDirectory)).toBe(2);
  });
});
