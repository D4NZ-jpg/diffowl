import { performance } from "node:perf_hooks";

import { expect, it } from "vitest";

import { executeArgvCommand } from "../src/host-verification.js";

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
