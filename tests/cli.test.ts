import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";

const fixturePath = fileURLToPath(
  new URL("./fixtures/pull-request.json", import.meta.url),
);
const policyPath = fileURLToPath(
  new URL("./fixtures/project-policy.json", import.meta.url),
);

describe("diffowl review", () => {
  it("runs the Review engine for pull-request input", async () => {
    let stdout = "";
    let stderr = "";

    const exitCode = await runCli(
      ["review", "--input", fixturePath, "--policy", policyPath],
      {
        readFile,
        stdout: (text) => {
          stdout += text;
        },
        stderr: (text) => {
          stderr += text;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      type: "partial_coverage",
      pullRequest: {
        repository: "example/review-target",
        number: 42,
        baseSha: "1111111111111111111111111111111111111111",
        headSha: "2222222222222222222222222222222222222222",
      },
      reason: "The tracer path does not analyze changes yet.",
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
        },
      },
    });
  });
});
