import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

import { type ReviewOutcome, runReview } from "./review-engine.js";

interface GitHubPullRequestEvent {
  repository: { full_name: string };
  pull_request: {
    number: number;
    base: { sha: string; repo: { full_name: string } };
    head: { sha: string; repo: { full_name: string } };
  };
}

export interface ActionIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readDiff(baseSha: string, headSha: string): Promise<string>;
  setOutput(name: string, value: string): Promise<void>;
}

function readGitDiff(baseSha: string, headSha: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["diff", "--no-ext-diff", baseSha, headSha, "--"],
      { encoding: "utf8", maxBuffer: 50 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function createActionIo(env: NodeJS.ProcessEnv): ActionIo {
  return {
    readFile,
    readDiff: readGitDiff,
    setOutput: async (name, value) => {
      const outputPath = env.GITHUB_OUTPUT;
      if (outputPath === undefined) {
        throw new Error("GITHUB_OUTPUT is required.");
      }
      await appendFile(outputPath, `${name}=${value}\n`, "utf8");
    },
  };
}

function isRepository(value: unknown): value is { full_name: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return typeof (value as Record<string, unknown>).full_name === "string";
}

function isRef(value: unknown): value is {
  sha: string;
  repo: { full_name: string };
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const ref = value as Record<string, unknown>;
  return typeof ref.sha === "string" && isRepository(ref.repo);
}

function isPullRequestEvent(value: unknown): value is GitHubPullRequestEvent {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value as Record<string, unknown>;
  if (!isRepository(event.repository)) {
    return false;
  }
  if (typeof event.pull_request !== "object" || event.pull_request === null) {
    return false;
  }
  const pullRequest = event.pull_request as Record<string, unknown>;
  return (
    typeof pullRequest.number === "number" &&
    Number.isInteger(pullRequest.number) &&
    isRef(pullRequest.base) &&
    isRef(pullRequest.head)
  );
}

export async function runAction(
  env: NodeJS.ProcessEnv,
  io: ActionIo = createActionIo(env),
): Promise<ReviewOutcome> {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath === undefined) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }

  const event: unknown = JSON.parse(await io.readFile(eventPath, "utf8"));
  if (!isPullRequestEvent(event)) {
    throw new Error("The GitHub event is not a pull-request event.");
  }

  const { pull_request: pullRequest, repository } = event;
  if (
    pullRequest.base.repo.full_name !== repository.full_name ||
    pullRequest.head.repo.full_name !== repository.full_name
  ) {
    throw new Error("The tracer Action supports same-repo pull requests only.");
  }

  const outcome = await runReview({
    repository: repository.full_name,
    number: pullRequest.number,
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
    diff: await io.readDiff(pullRequest.base.sha, pullRequest.head.sha),
  });

  await io.setOutput("outcome", JSON.stringify(outcome));
  return outcome;
}
