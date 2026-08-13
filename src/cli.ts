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

type CliPullRequestInput = Omit<PullRequestInput, "policy">;

function isPullRequestInput(value: unknown): value is CliPullRequestInput {
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

interface CliPaths {
  input: string;
  policy: string;
}

function pathsFrom(args: readonly string[]): CliPaths | undefined {
  if (
    args.length !== 5 ||
    args[0] !== "review" ||
    args[1] !== "--input" ||
    args[3] !== "--policy" ||
    args[2] === undefined ||
    args[4] === undefined
  ) {
    return undefined;
  }

  return { input: args[2], policy: args[4] };
}

export async function runCli(
  args: readonly string[],
  io: CliIo = processIo,
): Promise<number> {
  const paths = pathsFrom(args);
  if (paths === undefined) {
    io.stderr(
      "Usage: diffowl review --input <pull-request.json> --policy <local-policy.json>\n",
    );
    return 2;
  }

  try {
    const input: unknown = JSON.parse(await io.readFile(paths.input, "utf8"));
    if (!isPullRequestInput(input)) {
      io.stderr("Pull-request input does not match the required schema.\n");
      return 2;
    }

    const outcome = await runReview({
      ...input,
      policy: {
        source: { type: "local_invocation", path: paths.policy },
        contents: await io.readFile(paths.policy, "utf8"),
      },
    });
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
