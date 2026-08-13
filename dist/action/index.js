// src/action.ts
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

// src/review-engine.ts
async function runReview(input) {
  return {
    type: "partial_coverage",
    pullRequest: {
      repository: input.repository,
      number: input.number,
      baseSha: input.baseSha,
      headSha: input.headSha
    },
    reason: "The tracer path does not analyze changes yet."
  };
}

// src/action.ts
function readGitDiff(baseSha, headSha) {
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
      }
    );
  });
}
function createActionIo(env) {
  return {
    readFile,
    readDiff: readGitDiff,
    setOutput: async (name, value) => {
      const outputPath = env.GITHUB_OUTPUT;
      if (outputPath === void 0) {
        throw new Error("GITHUB_OUTPUT is required.");
      }
      await appendFile(outputPath, `${name}=${value}
`, "utf8");
    }
  };
}
function isRepository(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return typeof value.full_name === "string";
}
function isRef(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const ref = value;
  return typeof ref.sha === "string" && isRepository(ref.repo);
}
function isPullRequestEvent(value) {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const event = value;
  if (!isRepository(event.repository)) {
    return false;
  }
  if (typeof event.pull_request !== "object" || event.pull_request === null) {
    return false;
  }
  const pullRequest = event.pull_request;
  return typeof pullRequest.number === "number" && Number.isInteger(pullRequest.number) && isRef(pullRequest.base) && isRef(pullRequest.head);
}
async function runAction(env, io = createActionIo(env)) {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath === void 0) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }
  const event = JSON.parse(await io.readFile(eventPath, "utf8"));
  if (!isPullRequestEvent(event)) {
    throw new Error("The GitHub event is not a pull-request event.");
  }
  const { pull_request: pullRequest, repository } = event;
  if (pullRequest.base.repo.full_name !== repository.full_name || pullRequest.head.repo.full_name !== repository.full_name) {
    throw new Error("The tracer Action supports same-repo pull requests only.");
  }
  const outcome = await runReview({
    repository: repository.full_name,
    number: pullRequest.number,
    baseSha: pullRequest.base.sha,
    headSha: pullRequest.head.sha,
    diff: await io.readDiff(pullRequest.base.sha, pullRequest.head.sha)
  });
  await io.setOutput("outcome", JSON.stringify(outcome));
  return outcome;
}

// src/action-entry.ts
try {
  const outcome = await runAction(process.env);
  process.stdout.write(`${JSON.stringify(outcome)}
`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Review OWL failed: ${message}
`);
  process.exitCode = 1;
}
