import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRepositories: string[] = [];
const roleProfiles = {
  reviewer: {
    provider: "openai",
    model: "gpt-5",
    credentialProfile: "default",
  },
  challenger: {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    credentialProfile: "default",
  },
  verifier: {
    provider: "openai",
    model: "gpt-5-mini",
    credentialProfile: "default",
  },
};

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd: repository });
  return result.stdout.trim();
}

async function createRepresentativeRepository(): Promise<{
  repository: string;
  baseSha: string;
  headSha: string;
}> {
  const repository = await mkdtemp(join(tmpdir(), "diffowl-action-"));
  temporaryRepositories.push(repository);
  await git(repository, "init", "--quiet");
  await git(repository, "config", "user.name", "Review OWL Test");
  await git(repository, "config", "user.email", "review-owl@example.com");
  await writeFile(join(repository, "message.txt"), "hello\n", "utf8");
  await writeFile(
    join(repository, ".diffowl.json"),
    JSON.stringify({
      version: 1,
      scope: { includePaths: ["src/**"], excludePaths: ["dist/**"] },
      limits: { reviewTimeoutSeconds: 600, maxFindings: 25 },
      roleProfiles,
    }),
    "utf8",
  );
  await git(repository, "add", "message.txt", ".diffowl.json");
  await git(repository, "commit", "--quiet", "-m", "base");
  const baseSha = await git(repository, "rev-parse", "HEAD");
  await writeFile(join(repository, "message.txt"), "hello owl\n", "utf8");
  await writeFile(
    join(repository, ".diffowl.json"),
    JSON.stringify({
      version: 1,
      scope: { includePaths: ["**"], excludePaths: [] },
      limits: { reviewTimeoutSeconds: 3_601, maxFindings: 100 },
      roleProfiles,
    }),
    "utf8",
  );
  await git(repository, "commit", "--quiet", "-am", "head");
  return { repository, baseSha, headSha: await git(repository, "rev-parse", "HEAD") };
}

async function writePullRequestEvent(
  repository: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const eventPath = join(repository, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({
      repository: { full_name: "example/review-target" },
      pull_request: {
        number: 42,
        base: { sha: baseSha, repo: { full_name: "example/review-target" } },
        head: { sha: headSha, repo: { full_name: "example/review-target" } },
      },
    }),
    "utf8",
  );
  return eventPath;
}

describe("installable Review OWL Action", () => {
  it("runs the bundled Action in a representative same-repo checkout", async () => {
    const metadata = await readFile(join(projectRoot, "action.yml"), "utf8");
    expect(metadata).toContain("using: node24");
    expect(metadata).toContain("main: dist/action/index.js");

    const { repository, baseSha, headSha } = await createRepresentativeRepository();
    const eventPath = await writePullRequestEvent(repository, baseSha, headSha);
    const outputPath = join(repository, "action-output");
    const result = await exec("node", [join(projectRoot, "dist/action/index.js")], {
      cwd: repository,
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: "pull_request",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        OPENAI_API_KEY: "test-openai-secret",
        ANTHROPIC_API_KEY: "test-anthropic-secret",
      },
    });

    const outcome = JSON.parse(result.stdout);
    expect(outcome).toMatchObject({
      type: "provider_failure",
      reason: "Provider execution failed for the reviewer role.",
      executionArtifacts: [{ role: "reviewer" }],
      pullRequest: {
        repository: "example/review-target",
        number: 42,
        baseSha,
        headSha,
      },
      policy: {
        source: { type: "trusted_base_branch", revision: baseSha, path: ".diffowl.json" },
        effective: {
          version: 1,
          scope: { includePaths: ["src/**"], excludePaths: ["dist/**"] },
          limits: { reviewTimeoutSeconds: 600, maxFindings: 25 },
          roleProfiles,
        },
      },
    });
    expect(await readFile(outputPath, "utf8")).toBe(`outcome=${JSON.stringify(outcome)}\n`);
  });
});
