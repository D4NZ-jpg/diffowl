#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  type PullRequestInput,
  runReview,
} from "./review-engine.js";

export interface CliIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
}

const processIo: CliIo = {
  readFile,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function isPullRequestInput(value: unknown): value is PullRequestInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return (
    typeof input.repository === "string" &&
    typeof input.number === "number" &&
    Number.isInteger(input.number) &&
    typeof input.baseSha === "string" &&
    typeof input.headSha === "string" &&
    typeof input.diff === "string"
  );
}

function inputPathFrom(args: readonly string[]): string | undefined {
  if (args[0] !== "review" || args[1] !== "--input") {
    return undefined;
  }

  return args[2];
}

export async function runCli(
  args: readonly string[],
  io: CliIo = processIo,
): Promise<number> {
  const inputPath = inputPathFrom(args);
  if (inputPath === undefined) {
    io.stderr("Usage: diffowl review --input <pull-request.json>\n");
    return 2;
  }

  try {
    const input: unknown = JSON.parse(await io.readFile(inputPath, "utf8"));
    if (!isPullRequestInput(input)) {
      io.stderr("Pull-request input does not match the required schema.\n");
      return 2;
    }

    const outcome = await runReview(input);
    io.stdout(`${JSON.stringify(outcome)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Review failed: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (
  invokedPath !== undefined &&
  import.meta.url === pathToFileURL(invokedPath).href
) {
  process.exitCode = await runCli(process.argv.slice(2));
}
