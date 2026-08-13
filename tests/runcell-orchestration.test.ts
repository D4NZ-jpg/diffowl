import { describe, expect, it } from "vitest";
import type { AgentOptions, RunResult, Sandbox } from "runcell";

import { createRunCellRoleExecutor } from "../src/runcell-orchestration.js";
import type { RoleExecutionRequest } from "../src/review-engine.js";

function requestFor(role: "reviewer" | "challenger" | "verifier"): RoleExecutionRequest {
  const purposes = {
    reviewer: "generate_candidates" as const,
    challenger: "challenge_candidates" as const,
    verifier: "verify_candidates" as const,
  };
  return {
    pullRequest: {
      repository: "example/review-target",
      number: 42,
      baseSha: "1111111111111111111111111111111111111111",
      headSha: "2222222222222222222222222222222222222222",
    },
    diff: "diff --git a/src/message.ts b/src/message.ts\n-old\n+new\n",
    step: { role, purpose: purposes[role] } as RoleExecutionRequest["step"],
    profile: {
      provider: role === "challenger" ? "anthropic" : "openai",
      model: `${role}-model`,
      credentialProfile: "primary",
    },
    credentials: { type: "env" },
    roleInput: { role },
    maxCandidateFindings: 25,
    signal: new AbortController().signal,
  };
}

function sandboxFor(role: string): Sandbox {
  return {
    id: `${role}-sandbox`,
    capabilities: { ports: false, nativeSnapshot: false, resume: false },
    exec: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    readFile: async () => null,
    readTextFile: async () => null,
    writeFile: async () => undefined,
    remove: async () => undefined,
    snapshot: async () => ({
      version: 1,
      files: [{ path: `${role}.txt`, data: Buffer.from(role).toString("base64") }],
    }),
    lock: async (_key, fn) => fn(),
    destroy: async () => undefined,
  };
}

const roleOutputs = [
  {
    candidateFindings: [
      {
        summary: "Public output changed",
        location: { path: "src/message.ts", line: 1 },
        impact: "Consumers receive a new value.",
        evidence: ["The diff changes old to new."],
      },
    ],
    advisorySuggestions: [],
  },
  {
    assessments: [
      { candidateIndex: 0, verdict: "support", reason: "The changed value is material." },
    ],
  },
  {
    assessments: [
      {
        candidateIndex: 0,
        disposition: "material",
        explanation: "The diff demonstrates the changed value.",
        evidenceIds: ["scoped-diff"],
        limitations: [],
      },
    ],
  },
];

// The integration-style example keeps RunCell's complete execution contract visible.
// oxlint-disable-next-line max-lines-per-function
describe("createRunCellRoleExecutor", () => {
  it("uses structured files, events, and snapshots for each provider-backed role", async () => {
    const agentOptions: AgentOptions[] = [];
    const runOptions: Array<{ files?: { path: string }[] }> = [];
    let sandboxIndex = 0;

    const execute = createRunCellRoleExecutor({
      createSandbox: async () =>
        sandboxFor(["reviewer", "challenger", "verifier"][sandboxIndex++] ?? "unexpected"),
      createAgent: (options) => {
        const index = agentOptions.push(options) - 1;
        return {
          run: async (run) => {
            runOptions.push(run);
            run.events.onFinish?.({ sessionId: `session-${index}`, finishReason: "stop" });
            return {
              data: roleOutputs[index],
              text: "",
              files: [],
              finishReason: "stop",
              sessionId: `session-${index}`,
            } as RunResult<unknown>;
          },
        };
      },
    });

    const results = await Promise.all(
      (["reviewer", "challenger", "verifier"] as const).map((role) => execute(requestFor(role))),
    );

    expect(agentOptions.map(({ model }) => model)).toEqual([
      "openai/reviewer-model",
      "anthropic/challenger-model",
      "openai/verifier-model",
    ]);
    expect(runOptions.map(({ files }) => files?.map(({ path }) => path))).toEqual([
      ["pull-request.diff", "pull-request.json", "role-input.json"],
      ["pull-request.diff", "pull-request.json", "role-input.json"],
      ["pull-request.diff", "pull-request.json", "role-input.json"],
    ]);
    expect(results).toMatchObject([
      {
        type: "completed",
        output: { role: "reviewer", candidateFindings: [{ summary: "Public output changed" }] },
        artifact: { role: "reviewer", snapshot: { files: [{ path: "reviewer.txt" }] } },
      },
      {
        type: "completed",
        output: { role: "challenger", assessments: [{ verdict: "support" }] },
        artifact: { role: "challenger", snapshot: { files: [{ path: "challenger.txt" }] } },
      },
      {
        type: "completed",
        output: { role: "verifier", assessments: [{ disposition: "material" }] },
        artifact: { role: "verifier", snapshot: { files: [{ path: "verifier.txt" }] } },
      },
    ]);
  });

  it("reports candidate output above the configured ceiling as a budget limit", async () => {
    const execute = createRunCellRoleExecutor({
      createSandbox: async () => sandboxFor("reviewer-limit"),
      createAgent: () => ({
        run: async () =>
          ({
            data: {
              candidateFindings: Array.from(
                { length: 26 },
                () => roleOutputs[0]!.candidateFindings![0],
              ),
              advisorySuggestions: [],
            },
            text: "",
            files: [],
            finishReason: "stop",
            sessionId: "limited-session",
          }) as RunResult<unknown>,
      }),
    });

    const result = await execute(requestFor("reviewer"));

    expect(result).toMatchObject({
      type: "budget_limit",
      artifact: { role: "reviewer", snapshot: { files: [{ path: "reviewer-limit.txt" }] } },
    });
  });

  it("retains the failed role snapshot as an execution artifact", async () => {
    const execute = createRunCellRoleExecutor({
      createSandbox: async () => sandboxFor("reviewer-failure"),
      createAgent: () => ({ run: async () => Promise.reject(new Error("provider unavailable")) }),
    });

    const result = await execute(requestFor("reviewer"));

    expect(result).toMatchObject({
      type: "provider_failure",
      artifact: {
        role: "reviewer",
        finishReason: "error",
        snapshot: { files: [{ path: "reviewer-failure.txt" }] },
      },
    });
  });
});
