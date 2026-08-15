/* oxlint-disable max-lines */
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

import {
  actionReviewRequestIsActive,
  claimActionReviewRequest,
  completeActionReviewRequest,
  resolveActionEvent,
} from "./action-review-request.js";
import { runFindingDiscussionWork } from "./finding-discussion-work.js";
import { addedLinesFromDiff } from "./github-diff.js";
import { readGitFileAtRevision } from "./git-read.js";
import {
  publishFindingDiscussionUpdate,
  type FindingDiscussionPublicationReceipt,
  type FindingDiscussionPublicationUpdate,
} from "./github-finding-command.js";
import {
  createGitHubTransport,
  type PublicationAuthorization,
  type PublicationReceipt,
  type PublicationTarget,
  publishReviewOutcome,
} from "./github-publication.js";
import {
  publishActionOutcome,
  publishFindingDiscussionActionOutcome,
  recordNotAttemptedPublication,
  setReviewOutputs,
} from "./action-publication.js";
import { readReviewRequestPullRequest } from "./github-review-request.js";
import { createHostVerificationAdapter } from "./host-verification.js";
import { parseProjectPolicy, PROJECT_POLICY_PATH } from "./project-policy.js";
import {
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
import type { ReviewRequestPullRequest } from "./review-request.js";
import { classifyTrust } from "./trust.js";

export interface ActionIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readDiff(baseSha: string, headSha: string): Promise<string>;
  readPolicy(revision: string, path: string): Promise<string | undefined>;
  readPullRequest?(
    repository: string,
    pullRequestNumber: number,
  ): Promise<ReviewRequestPullRequest>;
  readCheckoutHead?(): Promise<string>;
  setOutput(name: string, value: string): Promise<void>;
  writeJobSummary?(contents: string): Promise<void>;
  workflowRunUrl?: string;
  publishFindingDiscussion?(
    update: FindingDiscussionPublicationUpdate,
  ): Promise<FindingDiscussionPublicationReceipt>;
  publishOutcome?(
    target: PublicationTarget,
    outcome: ReviewOutcome,
    authorization: PublicationAuthorization,
  ): Promise<PublicationReceipt>;
  credentialProfiles?: Readonly<Record<string, DiffowlCredentials>>;
  executeRole?(request: RoleExecutionRequest): Promise<RoleExecutionResult>;
  verificationAdapter?: VerificationAdapter;
  gitPersistence?: ReviewPersistenceStore;
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

function readGitHead(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["rev-parse", "HEAD"], { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout.trim());
    });
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
    readCheckoutHead: readGitHead,
    ...(token === undefined ? {} : { gitPersistence: new GitReviewPersistenceStore({ token }) }),
    setOutput: async (name, value) => {
      const outputPath = env.GITHUB_OUTPUT;
      if (outputPath === undefined) {
        throw new Error("GITHUB_OUTPUT is required.");
      }
      await appendFile(outputPath, `${name}=${value}\n`, "utf8");
    },
    writeJobSummary: async (contents) => {
      const summaryPath = env.GITHUB_STEP_SUMMARY;
      if (summaryPath !== undefined) await appendFile(summaryPath, `${contents}\n`, "utf8");
    },
    ...(env.GITHUB_SERVER_URL === undefined ||
    env.GITHUB_REPOSITORY === undefined ||
    env.GITHUB_RUN_ID === undefined
      ? {}
      : {
          workflowRunUrl: `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`,
        }),
    ...(transport === undefined
      ? {}
      : {
          readPullRequest: (repository: string, pullRequestNumber: number) =>
            readReviewRequestPullRequest(transport, repository, pullRequestNumber),
          publishFindingDiscussion: (update: FindingDiscussionPublicationUpdate) =>
            publishFindingDiscussionUpdate(transport, update),
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
  await recordNotAttemptedPublication(io, outcome);
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
  io: ActionIo,
): ReviewPersistenceStore | undefined {
  const stateDirectory = (env["INPUT_STATE-DIRECTORY"] ?? env.INPUT_STATE_DIRECTORY)?.trim();
  const githubHostedEligible =
    env.GITHUB_ACTIONS === "true" &&
    env.RUNNER_ENVIRONMENT === "github-hosted" &&
    trust.class === "trusted_same_repo_pull_request";
  if (githubHostedEligible) return io.gitPersistence ?? new GitReviewPersistenceStore();
  return stateDirectory === undefined || stateDirectory === ""
    ? undefined
    : new FileSystemReviewPersistenceStore(stateDirectory);
}

type ClaimedActionRequest = Awaited<ReturnType<typeof claimActionReviewRequest>>;

const commandDispositions = {
  accept: "accepted",
  rebut: "rebutted",
  suppress: "suppressed",
  ignore: "suppressed",
} as const;

function findingCommandDependencies(request: ClaimedActionRequest) {
  if (request === undefined || request === false || request.findingFingerprint === undefined) {
    return {};
  }
  const fingerprint = request.findingFingerprint;
  const disposition = commandDispositions[request.command as keyof typeof commandDispositions];
  return {
    ...(disposition === undefined ? {} : { findingDispositions: { [fingerprint]: disposition } }),
    ...(request.command === "resolved" ? { resolvedFingerprints: [fingerprint] } : {}),
    ...(request.command === "reassess"
      ? {
          reassessedFingerprints: [fingerprint],
          findingReassessmentContexts:
            request.findingContext === undefined ? {} : { [fingerprint]: request.findingContext },
        }
      : {}),
  };
}

function reviewDependencies(
  env: NodeJS.ProcessEnv,
  io: ActionIo,
  persistence: ReviewPersistenceStore | undefined,
  request: ClaimedActionRequest,
) {
  return {
    credentialProfiles: io.credentialProfiles ?? { default: { type: "env" as const } },
    executeRole: io.executeRole,
    verificationAdapter: actionVerificationAdapter(env, io.verificationAdapter),
    persistence,
    ...findingCommandDependencies(request),
  };
}

// oxlint-disable-next-line complexity, max-lines-per-function
export async function runAction(
  env: NodeJS.ProcessEnv,
  io: ActionIo = createActionIo(env),
): Promise<ReviewOutcome> {
  const resolved = await resolveActionEvent(env, io);
  if (!resolved.valid) return unsafeContextOutcome(io, resolved.type, resolved.reason);
  const { event } = resolved;
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

  const persistence = actionPersistence(env, trust, io);
  const request = await claimActionReviewRequest(env, event, persistence);
  if (request === false) {
    return unsafeContextOutcome(
      io,
      "policy_skip",
      "The workflow dispatch is not backed by an accepted Review request.",
    );
  }
  let findingPublicationComplete = false;
  try {
    const policyContents = await io.readPolicy(pullRequest.base.sha, PROJECT_POLICY_PATH);
    if (request !== undefined && request.workType === "finding_discussion") {
      const policy = parseProjectPolicy(policyContents);
      if (
        !policy.valid ||
        persistence === undefined ||
        request.findingFingerprint === undefined ||
        request.rootCommentId === undefined ||
        request.command === "review"
      ) {
        return unsafeContextOutcome(
          io,
          "policy_skip",
          policy.valid
            ? "The accepted Finding command is missing durable dispatch context."
            : policy.reason,
        );
      }
      const result = await runFindingDiscussionWork(
        {
          repository: repository.full_name,
          pullRequestNumber: pullRequest.number,
          baseSha: pullRequest.base.sha,
          headSha: pullRequest.head.sha,
          eventId: request.eventId,
          workflowRunId: request.workflowRunId,
          command: request.command,
          fingerprint: request.findingFingerprint,
          context: request.findingContext,
          policy: policy.policy,
          policySource: {
            type: "trusted_base_branch",
            revision: pullRequest.base.sha,
            path: PROJECT_POLICY_PATH,
          },
          trust,
        },
        {
          persistence,
          verificationAdapter: actionVerificationAdapter(env, io.verificationAdapter),
          credentialProfiles: io.credentialProfiles ?? { default: { type: "env" as const } },
          executeRole: io.executeRole,
        },
      );
      if (!(await actionReviewRequestIsActive(event, persistence, request))) {
        await recordNotAttemptedPublication(io, result.outcome);
        throw new Error("The Finding command was superseded before publication.");
      }
      await publishFindingDiscussionActionOutcome(
        io,
        repository.full_name,
        pullRequest.number,
        request.eventId,
        result.outcome,
        {
          repository: repository.full_name,
          pullRequestNumber: pullRequest.number,
          headSha: pullRequest.head.sha,
          rootCommentId: request.rootCommentId,
          lifecycleState: result.lifecycleState,
          body: result.replyBody,
          effectMarker: `<!-- diffowl:finding-update:v1 event=${request.eventId} fingerprint=${request.findingFingerprint} root=${request.rootCommentId} -->`,
        },
        persistence,
      );
      findingPublicationComplete = true;
      return result.outcome;
    }
    const diff = await io.readDiff(pullRequest.base.sha, pullRequest.head.sha);
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
      reviewDependencies(env, io, persistence, request),
    );

    if (!(await actionReviewRequestIsActive(event, persistence, request))) {
      await recordNotAttemptedPublication(io, outcome);
      throw new Error("The Review request was superseded before publication.");
    }
    await publishActionOutcome(
      io,
      repository.full_name,
      pullRequest,
      outcome,
      addedLinesFromDiff(diff),
      persistence,
    );
    return outcome;
  } finally {
    if (request === undefined || request.workType !== "finding_discussion") {
      await completeActionReviewRequest(event, persistence, request);
    } else if (findingPublicationComplete) {
      await completeActionReviewRequest(event, persistence, request);
    }
  }
}
