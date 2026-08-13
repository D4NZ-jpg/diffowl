import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

import {
  PROJECT_POLICY_PATH,
  type DiffowlCredentials,
  type ReviewOutcome,
  type RoleExecutionRequest,
  type RoleExecutionResult,
  runReview,
} from "./review-engine.js";
import { classifyTrust } from "./trust.js";

interface GitHubPullRequestEvent {
  repository: { full_name: string };
  pull_request: {
    number: number;
    base: { sha: string; repo: { full_name: string } };
    head: { sha: string; repo: { full_name: string } };
    user?: { login: string };
  };
}

export interface ActionIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readDiff(baseSha: string, headSha: string): Promise<string>;
  readPolicy(revision: string, path: string): Promise<string | undefined>;
  setOutput(name: string, value: string): Promise<void>;
  credentialProfiles?: Readonly<Record<string, DiffowlCredentials>>;
  executeRole?(request: RoleExecutionRequest): Promise<RoleExecutionResult>;
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

function readGitFileAtRevision(revision: string, path: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["show", `${revision}:${path}`],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        if (stderr.includes("does not exist in") || stderr.includes("exists on disk, but not in")) {
          resolve(undefined);
          return;
        }
        reject(error);
      },
    );
  });
}

function createActionIo(env: NodeJS.ProcessEnv): ActionIo {
  return {
    readFile,
    readDiff: readGitDiff,
    readPolicy: readGitFileAtRevision,
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

async function skipUnsafeContext(io: ActionIo, reason: string): Promise<ReviewOutcome> {
  const outcome: ReviewOutcome = {
    type: "policy_skip",
    reason,
    trust: classifyTrust({ type: "unsupported", reason }),
  };
  await io.setOutput("outcome", JSON.stringify(outcome));
  return outcome;
}

export async function runAction(
  env: NodeJS.ProcessEnv,
  io: ActionIo = createActionIo(env),
): Promise<ReviewOutcome> {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath === undefined) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    return skipUnsafeContext(
      io,
      `GitHub event "${env.GITHUB_EVENT_NAME ?? "unknown"}" is not a safe pull_request context.`,
    );
  }

  const event: unknown = JSON.parse(await io.readFile(eventPath, "utf8"));
  if (!isPullRequestEvent(event)) {
    return skipUnsafeContext(io, "The GitHub event is not a supported pull-request event.");
  }

  const { pull_request: pullRequest, repository } = event;
  if (pullRequest.base.repo.full_name !== repository.full_name) {
    return skipUnsafeContext(
      io,
      "The pull request base repository does not match the event repository.",
    );
  }

  const trust = classifyTrust({
    type: "github_pull_request",
    repository: repository.full_name,
    headRepository: pullRequest.head.repo.full_name,
    actor: pullRequest.user?.login,
  });

  const outcome = await runReview(
    {
      repository: repository.full_name,
      number: pullRequest.number,
      baseSha: pullRequest.base.sha,
      headSha: pullRequest.head.sha,
      diff: await io.readDiff(pullRequest.base.sha, pullRequest.head.sha),
      trust,
      policy: {
        source: {
          type: "trusted_base_branch",
          revision: pullRequest.base.sha,
          path: PROJECT_POLICY_PATH,
        },
        contents: await io.readPolicy(pullRequest.base.sha, PROJECT_POLICY_PATH),
      },
    },
    {
      credentialProfiles: io.credentialProfiles ?? { default: { type: "env" } },
      executeRole: io.executeRole,
    },
  );

  await io.setOutput("outcome", JSON.stringify(outcome));
  return outcome;
}
