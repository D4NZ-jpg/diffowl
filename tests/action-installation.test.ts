import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { defaultRoleProfiles } from "./review-fixtures.js";

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const temporaryRepositories: string[] = [];
const roleProfiles = defaultRoleProfiles;

afterEach(async () => {
  await Promise.all(
    temporaryRepositories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function git(repository: string, ...args: string[]): Promise<string> {
  const result = await exec("git", args, { cwd: repository });
  return result.stdout.trim();
}

async function actionStdout(repository: string, env: NodeJS.ProcessEnv): Promise<string> {
  try {
    const result = await exec("node", [join(projectRoot, "dist/action/index.js")], {
      cwd: repository,
      env,
    });
    return result.stdout;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "stdout" in error &&
      typeof (error as { stdout: unknown }).stdout === "string"
    ) {
      return (error as { stdout: string }).stdout;
    }
    throw error;
  }
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
      verification: { validationCommands: [] },
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
      verification: { validationCommands: [] },
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

it("cancels a superseded pull-request review workflow", async () => {
  const workflow = await readFile(
    join(projectRoot, "examples/representative-repository/.github/workflows/review-owl.yml"),
    "utf8",
  );

  expect(workflow).toContain(
    "group: review-owl-${{ inputs.pull-request-number || github.event.pull_request.number }}",
  );
  expect(workflow).toContain("cancel-in-progress: true");
});

// oxlint-disable-next-line max-lines-per-function
it("installs a trusted issue-comment router and one canonical review workflow", async () => {
  const [
    router,
    review,
    routerMetadata,
    actionMetadata,
    actionBundle,
    routerBundle,
    readme,
    packageManifest,
  ] = await Promise.all([
    readFile(
      join(projectRoot, "examples/representative-repository/.github/workflows/review-request.yml"),
      "utf8",
    ),
    readFile(
      join(projectRoot, "examples/representative-repository/.github/workflows/review-owl.yml"),
      "utf8",
    ),
    readFile(join(projectRoot, "review-request/action.yml"), "utf8"),
    readFile(join(projectRoot, "action.yml"), "utf8"),
    readFile(join(projectRoot, "dist/action/index.js"), "utf8"),
    readFile(join(projectRoot, "review-request/dist/index.js"), "utf8"),
    readFile(join(projectRoot, "README.md"), "utf8"),
    readFile(join(projectRoot, "package.json"), "utf8"),
  ]);

  expect(router).toContain("issue_comment:");
  expect(router).toContain("pull_request_review_comment:");
  expect(router).toContain("types: [created]");
  expect(router).toContain("ref: ${{ github.event.repository.default_branch }}");
  expect(router).toContain("actions: write");
  expect(router).toContain("contents: write");
  expect(router).toContain("pull-requests: write");
  expect(router).toContain("issues: write");
  expect(router).toContain("persist-credentials: false");
  expect(router).toContain("uses: D4NZ-jpg/diffowl/review-request@v0");
  expect(router).not.toContain("OPENAI_API_KEY");
  expect(router).not.toContain("ANTHROPIC_API_KEY");

  expect(review).toContain("workflow_dispatch:");
  expect(review).toContain("review-request-event-id:");
  expect(review).toContain("command-work-type:");
  expect(review).toContain("finding-fingerprint:");
  expect(review).toContain("finding-context:");
  expect(review).toContain("finding-root-comment-id:");
  expect(review).toContain("ref: ${{ inputs.head-sha || github.event.pull_request.head.sha }}");
  expect(review).toContain("persist-credentials: false");
  expect(review).toContain("issues: read");
  expect(review).not.toContain("checks: write");
  expect(review).toContain(
    "group: review-owl-${{ inputs.pull-request-number || github.event.pull_request.number }}",
  );
  expect(routerMetadata).toContain("using: node24");
  expect(routerMetadata).toContain("main: dist/index.js");
  expect(actionMetadata).toContain("self-hosted-state-directory:");
  expect(actionMetadata).not.toMatch(/^  state-directory:/mu);
  expect(actionBundle).toContain("INPUT_SELF-HOSTED-STATE-DIRECTORY");
  expect(routerBundle).not.toContain("/diffowl rerun");
  expect(readme).toContain("`self-hosted-state-directory`");
  expect(readme).not.toContain("/diffowl rerun");
  expect(JSON.parse(packageManifest).files).toEqual(
    expect.arrayContaining([
      "action.yml",
      "dist",
      "review-request",
      "examples/representative-repository",
    ]),
  );
});

// oxlint-disable-next-line max-lines-per-function
describe("installable Review OWL Action", () => {
  // oxlint-disable-next-line max-lines-per-function
  it("runs the bundled Action in a representative same-repo checkout", async () => {
    const metadata = await readFile(join(projectRoot, "action.yml"), "utf8");
    expect(metadata).toContain("using: node24");
    expect(metadata).toContain("main: dist/action/index.js");
    expect(metadata).toContain("self-hosted-state-directory:");
    expect(metadata).not.toMatch(/^  state-directory:/mu);
    expect(metadata).toContain("run-id:");
    expect(metadata).toContain("run-metadata:");
    expect(metadata).toContain("publication:");

    const { repository, baseSha, headSha } = await createRepresentativeRepository();
    const eventPath = await writePullRequestEvent(repository, baseSha, headSha);
    const outputPath = join(repository, "action-output");
    const stateDirectory = join(repository, ".durable-diffowl-state");
    const actionEnvironment = {
      ...process.env,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: outputPath,
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "self-hosted",
      "INPUT_SELF-HOSTED-STATE-DIRECTORY": stateDirectory,
      OPENAI_API_KEY: "test-openai-secret",
      ANTHROPIC_API_KEY: "test-anthropic-secret",
    };
    const stdout = await actionStdout(repository, {
      ...actionEnvironment,
      GITHUB_TOKEN: undefined,
    });

    const outcome = JSON.parse(stdout);
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
          verification: { validationCommands: [] },
          roleProfiles,
        },
      },
    });
    const output = await readFile(outputPath, "utf8");
    expect(output).toContain(`outcome=${JSON.stringify(outcome)}\n`);
    expect(output).toContain(`run-id=${outcome.run.runId}\n`);
    expect(output).toContain(`run-metadata=${JSON.stringify(outcome.run)}\n`);

    await actionStdout(repository, {
      ...actionEnvironment,
      GITHUB_OUTPUT: join(repository, "second-action-output"),
    });
    const manifest = JSON.parse(
      await readFile(
        join(stateDirectory, "repositories/example/review-target/pull-requests/42/manifest.json"),
        "utf8",
      ),
    ) as { runs: Record<string, string> };
    expect(Object.keys(manifest.runs)).toHaveLength(2);
  }, 30_000);

  it("explains the required GitHub token instead of falling back from Git state", async () => {
    const { repository, baseSha, headSha } = await createRepresentativeRepository();
    const eventPath = await writePullRequestEvent(repository, baseSha, headSha);
    const stdout = await actionStdout(repository, {
      ...process.env,
      GITHUB_ACTIONS: "true",
      RUNNER_ENVIRONMENT: "github-hosted",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventPath,
      GITHUB_OUTPUT: join(repository, "action-output"),
      GITHUB_TOKEN: undefined,
    });

    expect(JSON.parse(stdout)).toMatchObject({
      type: "configuration_failure",
      reason: expect.stringMatching(/GITHUB_TOKEN.*contents: write/iu),
    });
  }, 30_000);
});
