import { performance } from "node:perf_hooks";

import { expect, it } from "vitest";

import {
  createContainerSuggestedPatchValidator,
  executeArgvCommand,
} from "../src/host-verification.js";

it("executes argv without shell expansion and bounds captured output", async () => {
  const result = await executeArgvCommand({
    argv: [
      process.execPath,
      "-e",
      "process.stdout.write(process.argv[1]); process.stderr.write('abcdefgh')",
      "$HOME; echo unsafe",
    ],
    timeoutSeconds: 5,
    maxOutputBytes: 8,
    signal: new AbortController().signal,
  });

  expect(result).toMatchObject({
    status: "passed",
    exitCode: 0,
    stdout: "$HOME; e",
    stderr: "",
    truncated: true,
  });
});

it("keeps multibyte captured output within its byte ceiling", async () => {
  const result = await executeArgvCommand({
    argv: [process.execPath, "-e", "process.stdout.write('😀'.repeat(4))"],
    timeoutSeconds: 5,
    maxOutputBytes: 7,
    signal: new AbortController().signal,
  });

  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(7);
  expect(result.stdout).toBe("😀");
  expect(result.stdout).not.toContain("�");
  expect(result.truncated).toBe(true);
});

it("does not inherit credentials or the host HOME", async () => {
  const priorToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "must-not-leak";
  try {
    const result = await executeArgvCommand({
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify({home: process.env.HOME, token: process.env.GITHUB_TOKEN}))",
      ],
      timeoutSeconds: 5,
      maxOutputBytes: 1_000,
      signal: new AbortController().signal,
    });

    expect(JSON.parse(result.stdout)).toEqual({});
  } finally {
    if (priorToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = priorToken;
  }
});

it("terminates a validation process tree at its configured timeout", async () => {
  const started = performance.now();
  const result = await executeArgvCommand({
    argv: [
      process.execPath,
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        "spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'ignore', 'inherit'] });",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join(" "),
    ],
    timeoutSeconds: 1,
    maxOutputBytes: 100,
    signal: new AbortController().signal,
  });

  expect(result.status).toBe("timed_out");
  expect(performance.now() - started).toBeLessThan(3_000);
});

// This system-boundary test keeps all non-overridable container controls visible together.
// oxlint-disable-next-line max-lines-per-function
it("validates an exact-head patch in a no-network bounded digest-pinned container", async () => {
  const checkouts: Array<{ headSha: string; maxBytes: number; aborted: boolean }> = [];
  const writes: string[] = [];
  const runs: string[][] = [];
  const cleanups: Array<[string, boolean]> = [];
  const validate = createContainerSuggestedPatchValidator({
    createWorkspace: async () => "/tmp/diffowl-test-workspace",
    checkoutExactHead: async (_workspace, headSha, maxBytes, signal) => {
      checkouts.push({ headSha, maxBytes, aborted: signal.aborted });
    },
    readWorkspaceFile: async () => "before\nunsafe\nafter\n",
    writePatchedFile: async (_path, contents) => {
      writes.push(contents);
    },
    statWorkspaceFile: async () => ({
      size: 21,
      isFile: () => true,
      isSymbolicLink: () => false,
    }),
    runContainer: async (request) => {
      runs.push(request.argv);
      return {
        status: "passed",
        exitCode: 0,
        stdout: "passed",
        stderr: "",
        truncated: false,
      };
    },
    cleanup: async (workspace, checkedOut) => {
      cleanups.push([workspace, checkedOut]);
    },
  });

  const result = await validate({
    repository: "example/repo",
    headSha: "2".repeat(40),
    path: "src/handler.ts",
    startLine: 2,
    endLine: 2,
    expected: "unsafe",
    replacement: "safe",
    sandboxImage: `node@sha256:${"a".repeat(64)}`,
    command: { commandIndex: 0, argv: ["npm", "test", "--", "handler"], timeoutSeconds: 30 },
    security: {
      network: "denied",
      secrets: "denied",
      memoryBytes: 1_073_741_824,
      cpuCount: 2,
      processLimit: 128,
      temporaryBytes: 67_108_864,
      workspace: "read_only",
    },
    signal: new AbortController().signal,
  });

  expect(result.status).toBe("passed");
  expect(checkouts).toEqual([{ headSha: "2".repeat(40), maxBytes: 67_108_864, aborted: false }]);
  expect(writes).toEqual(["before\nsafe\nafter\n"]);
  expect(runs[0]).toEqual(
    expect.arrayContaining([
      "--pull",
      "never",
      "--cidfile",
      "/tmp/diffowl-test-workspace.cid",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--memory",
      "1073741824",
      "--cpus",
      "2",
      "--pids-limit",
      "128",
      `node@sha256:${"a".repeat(64)}`,
    ]),
  );
  expect(runs[0]?.join(" ")).not.toContain("GITHUB_TOKEN");
  expect(cleanups).toEqual([["/tmp/diffowl-test-workspace", true]]);
});

it("resolves promptly when an aborted command ignores SIGTERM", async () => {
  const controller = new AbortController();
  const started = performance.now();
  setTimeout(() => controller.abort(), 50);
  const result = await executeArgvCommand({
    argv: [process.execPath, "-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
    timeoutSeconds: 5,
    maxOutputBytes: 100,
    signal: controller.signal,
  });

  expect(result.status).toBe("aborted");
  expect(performance.now() - started).toBeLessThan(2_000);
});
