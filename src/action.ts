import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

import { type GitHubPullRequestEvent, isPullRequestEvent } from "./action-event.js";
import type { JsonValue } from "./canonical-json.js";
import { addedLinesFromDiff } from "./github-diff.js";
import {
  REQUIRED_PUBLICATION_SURFACES,
  createGitHubTransport,
  type PublicationAuthorization,
  type PublicationReceipt,
  type PublicationTarget,
  publishReviewOutcome,
} from "./github-publication.js";
import {
  type FindingDiscussionComment,
  recognizeFindingDiscussionCommands,
} from "./finding-discussion.js";
import { listFindingDiscussionComments } from "./github-discussion.js";
import { createHostVerificationAdapter } from "./host-verification.js";
import {
  PROJECT_POLICY_PATH,
  type DiffowlCredentials,
  type ReviewOutcome,
  type RoleExecutionRequest,
  type RoleExecutionResult,
  type VerificationAdapter,
  FileSystemReviewPersistenceStore,
  GitReviewPersistenceStore,
  type ReviewPersistenceStore,
  runReview,
  unavailableVerificationAdapter,
} from "./review-engine.js";
import { classifyTrust } from "./trust.js";

export interface ActionIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readDiff(baseSha: string, headSha: string): Promise<string>;
  readPolicy(revision: string, path: string): Promise<string | undefined>;
  setOutput(name: string, value: string): Promise<void>;
  listFindingDiscussionComments?(
    repository: string,
    pullRequestNumber: number,
  ): Promise<FindingDiscussionComment[]>;
  publishOutcome?(
    target: PublicationTarget,
    outcome: ReviewOutcome,
    authorization: PublicationAuthorization,
  ): Promise<PublicationReceipt>;
  credentialProfiles?: Readonly<Record<string, DiffowlCredentials>>;
  executeRole?(request: RoleExecutionRequest): Promise<RoleExecutionResult>;
  verificationAdapter?: VerificationAdapter;
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

export function createActionIo(env: NodeJS.ProcessEnv): ActionIo {
  const token = env.GITHUB_TOKEN;
  delete env.GITHUB_TOKEN;
  const transport =
    token === undefined ? undefined : createGitHubTransport(token, env.GITHUB_API_URL);
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
    ...(transport === undefined
      ? {}
      : {
          listFindingDiscussionComments: (repository: string, pullRequestNumber: number) =>
            listFindingDiscussionComments(transport, repository, pullRequestNumber),
          publishOutcome: (
            target: PublicationTarget,
            outcome: ReviewOutcome,
            authorization: PublicationAuthorization,
          ) => publishReviewOutcome(transport, target, outcome, authorization),
        }),
  };
}

async function unsafeContextOutcome(
  io: ActionIo,
  type: "policy_skip" | "unsupported_change",
  reason: string,
): Promise<ReviewOutcome> {
  const outcome: ReviewOutcome = {
    type,
    reason,
    trust: classifyTrust({ type: "unsupported", reason }),
  };
  await setReviewOutputs(io, outcome);
  return outcome;
}

function actionVerificationAdapter(
  env: NodeJS.ProcessEnv,
  configured: VerificationAdapter | undefined,
): VerificationAdapter {
  if (configured !== undefined) return configured;
  return env.RUNNER_ENVIRONMENT === "github-hosted"
    ? createHostVerificationAdapter()
    : unavailableVerificationAdapter;
}

function actionPersistence(
  env: NodeJS.ProcessEnv,
  trust: ReturnType<typeof classifyTrust>,
): ReviewPersistenceStore | undefined {
  const stateDirectory = (env["INPUT_STATE-DIRECTORY"] ?? env.INPUT_STATE_DIRECTORY)?.trim();
  const githubHostedEligible =
    env.GITHUB_ACTIONS === "true" &&
    env.RUNNER_ENVIRONMENT === "github-hosted" &&
    trust.class === "trusted_same_repo_pull_request";
  if (githubHostedEligible) return new GitReviewPersistenceStore();
  return stateDirectory === undefined || stateDirectory === ""
    ? undefined
    : new FileSystemReviewPersistenceStore(stateDirectory);
}

async function reviewDependencies(
  env: NodeJS.ProcessEnv,
  io: ActionIo,
  repository: string,
  pullRequest: GitHubPullRequestEvent["pull_request"],
  persistence: ReviewPersistenceStore | undefined,
) {
  const effects = recognizeFindingDiscussionCommands(
    (await io.listFindingDiscussionComments?.(repository, pullRequest.number)) ?? [],
    { authorLogins: pullRequest.user?.login === undefined ? [] : [pullRequest.user.login] },
  );
  return {
    credentialProfiles: io.credentialProfiles ?? { default: { type: "env" as const } },
    executeRole: io.executeRole,
    verificationAdapter: actionVerificationAdapter(env, io.verificationAdapter),
    persistence,
    findingDispositions: effects.dispositions,
    resolvedFingerprints: effects.resolvedFingerprints,
    reassessedFingerprints: effects.reassessedFingerprints,
    findingDiscussionEvents: effects.events,
  };
}

async function setReviewOutputs(io: ActionIo, outcome: ReviewOutcome): Promise<void> {
  await io.setOutput("outcome", JSON.stringify(outcome));
  if (outcome.run !== undefined) {
    await io.setOutput("run-id", outcome.run.runId);
    await io.setOutput("run-metadata", JSON.stringify(outcome.run));
  }
}

function publicationFailureOutcome(outcome: ReviewOutcome, error: unknown): ReviewOutcome {
  if (!("pullRequest" in outcome) || !("policy" in outcome)) return outcome;
  const reason = error instanceof Error ? error.message : "GitHub publication failed.";
  return {
    type: "internal_failure",
    reason,
    trust: outcome.trust,
    pullRequest: outcome.pullRequest,
    policy: outcome.policy,
    ...(outcome.run === undefined ? {} : { run: outcome.run }),
  };
}

async function publishActionOutcome(
  io: ActionIo,
  repository: string,
  pullRequest: GitHubPullRequestEvent["pull_request"],
  outcome: ReviewOutcome,
  changedLines: PublicationTarget["changedLines"],
  persistence: ReviewPersistenceStore | undefined,
): Promise<void> {
  await setReviewOutputs(io, outcome);
  if (io.publishOutcome === undefined || outcome.trust.class !== "trusted_same_repo_pull_request") {
    return;
  }
  try {
    const receipt = await io.publishOutcome(
      {
        repository,
        pullRequestNumber: pullRequest.number,
        headSha: pullRequest.head.sha,
        changedLines,
      },
      outcome,
      { sourceRunVerified: true, surfaces: REQUIRED_PUBLICATION_SURFACES },
    );
    await io.setOutput("publication", JSON.stringify(receipt));
    if (outcome.run !== undefined) {
      await persistence?.withTransaction(
        { repository, pullRequestNumber: pullRequest.number },
        async (transaction) =>
          transaction.savePublicationEffects(outcome.run!.runId, receipt as unknown as JsonValue),
      );
    }
  } catch (error) {
    await setReviewOutputs(io, publicationFailureOutcome(outcome, error));
    throw error;
  }
}

// oxlint-disable-next-line max-lines-per-function
export async function runAction(
  env: NodeJS.ProcessEnv,
  io: ActionIo = createActionIo(env),
): Promise<ReviewOutcome> {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath === undefined) {
    throw new Error("GITHUB_EVENT_PATH is required.");
  }
  if (env.GITHUB_EVENT_NAME !== "pull_request") {
    return unsafeContextOutcome(
      io,
      "policy_skip",
      `GitHub event "${env.GITHUB_EVENT_NAME ?? "unknown"}" is not a safe pull_request context.`,
    );
  }

  const event: unknown = JSON.parse(await io.readFile(eventPath, "utf8"));
  if (!isPullRequestEvent(event)) {
    return unsafeContextOutcome(
      io,
      "unsupported_change",
      "The GitHub event is not a supported pull-request event.",
    );
  }

  const { pull_request: pullRequest, repository } = event;
  if (pullRequest.base.repo.full_name !== repository.full_name) {
    return unsafeContextOutcome(
      io,
      "policy_skip",
      "The pull request base repository does not match the event repository.",
    );
  }

  const trust = classifyTrust({
    type: "github_pull_request",
    repository: repository.full_name,
    headRepository: pullRequest.head.repo.full_name,
    actor: pullRequest.user?.login,
  });

  const persistence = actionPersistence(env, trust);
  const diff = await io.readDiff(pullRequest.base.sha, pullRequest.head.sha);
  const policyContents = await io.readPolicy(pullRequest.base.sha, PROJECT_POLICY_PATH);
  const outcome = await runReview(
    {
      repository: repository.full_name,
      number: pullRequest.number,
      baseSha: pullRequest.base.sha,
      headSha: pullRequest.head.sha,
      diff,
      trust,
      policy: {
        source: {
          type: "trusted_base_branch",
          revision: pullRequest.base.sha,
          path: PROJECT_POLICY_PATH,
        },
        contents: policyContents,
      },
    },
    await reviewDependencies(env, io, repository.full_name, pullRequest, persistence),
  );

  await publishActionOutcome(
    io,
    repository.full_name,
    pullRequest,
    outcome,
    addedLinesFromDiff(diff),
    persistence,
  );
  return outcome;
}
