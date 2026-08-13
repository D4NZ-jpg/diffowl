// src/action.ts
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

// src/review-engine.ts
var PROJECT_POLICY_PATH = ".diffowl.json";
var PROJECT_POLICY_CEILINGS = {
  reviewTimeoutSeconds: 3600,
  maxFindings: 100
};
function pullRequestFrom(input) {
  return {
    repository: input.repository,
    number: input.number,
    baseSha: input.baseSha,
    headSha: input.headSha
  };
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function unsupportedField(value, supported, location) {
  const field = Object.keys(value).find((key) => !supported.includes(key));
  return field === void 0 ? void 0 : `Project policy ${location} contains unsupported field "${field}".`;
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}
function isPositiveInteger(value) {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
function validateScope(value) {
  if (!isRecord(value)) {
    return "Project policy scope must be an object.";
  }
  const fieldError = unsupportedField(value, ["includePaths", "excludePaths"], "scope");
  if (fieldError !== void 0) {
    return fieldError;
  }
  if (!isStringArray(value.includePaths) || !isStringArray(value.excludePaths)) {
    return "Project policy scope paths must be arrays of non-empty strings.";
  }
  return void 0;
}
function validateLimit(value, name) {
  if (!isPositiveInteger(value)) {
    return `Project policy limits.${name} must be a positive integer.`;
  }
  const ceiling = PROJECT_POLICY_CEILINGS[name];
  return value > ceiling ? `Project policy limits.${name} exceeds the security ceiling of ${ceiling}.` : void 0;
}
function validateLimits(value) {
  if (!isRecord(value)) {
    return "Project policy limits must be an object.";
  }
  const fieldError = unsupportedField(value, ["reviewTimeoutSeconds", "maxFindings"], "limits");
  return fieldError ?? validateLimit(value.reviewTimeoutSeconds, "reviewTimeoutSeconds") ?? validateLimit(value.maxFindings, "maxFindings");
}
function validatePolicy(value) {
  if (!isRecord(value)) {
    return "Project policy must be a JSON object.";
  }
  const fieldError = unsupportedField(value, ["version", "scope", "limits"], "root");
  if (fieldError !== void 0) {
    return fieldError;
  }
  if (value.version !== 1) {
    return "Project policy version must be 1.";
  }
  return validateScope(value.scope) ?? validateLimits(value.limits);
}
function parseProjectPolicy(contents) {
  if (contents === void 0) {
    return { valid: false, reason: "Project policy is missing." };
  }
  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    return { valid: false, reason: "Project policy is not valid JSON." };
  }
  const reason = validatePolicy(value);
  if (reason !== void 0) {
    return { valid: false, reason };
  }
  return { valid: true, policy: value };
}
async function runReview(input) {
  const result = parseProjectPolicy(input.policy.contents);
  if (!result.valid) {
    return {
      type: "configuration_failure",
      pullRequest: pullRequestFrom(input),
      policySource: input.policy.source,
      reason: result.reason
    };
  }
  return {
    type: "partial_coverage",
    pullRequest: pullRequestFrom(input),
    reason: "The tracer path does not analyze changes yet.",
    policy: {
      source: input.policy.source,
      effective: result.policy
    }
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
function readGitFileAtRevision(revision, path) {
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
          resolve(void 0);
          return;
        }
        reject(error);
      }
    );
  });
}
function createActionIo(env) {
  return {
    readFile,
    readDiff: readGitDiff,
    readPolicy: readGitFileAtRevision,
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
    diff: await io.readDiff(pullRequest.base.sha, pullRequest.head.sha),
    policy: {
      source: {
        type: "trusted_base_branch",
        revision: pullRequest.base.sha,
        path: PROJECT_POLICY_PATH
      },
      contents: await io.readPolicy(pullRequest.base.sha, PROJECT_POLICY_PATH)
    }
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
