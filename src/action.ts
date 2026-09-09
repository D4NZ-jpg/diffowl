/* oxlint-disable max-lines */
import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";

import {
  actionReviewRequestIsActive,
  claimActionReviewRequest,
  completeActionReviewRequest,
  resolveActionEvent,
} from "./action-review-request.js";
import type { GitHubPullRequestEvent } from "./action-event.js";
import { runFindingDiscussionWork } from "./finding-discussion-work.js";
import { addedLinesFromDiff } from "./github-diff.js";
import { resolveActionCredentials } from "./action-credentials.js";
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
import { readRepositoryPermission, readReviewRequestPullRequest } from "./github-review-request.js";
import { createHostVerificationAdapter } from "./host-verification.js";
import {
  collaboratorForksTrusted,
  parseProjectPolicy,
  PROJECT_POLICY_PATH,
} from "./project-policy.js";
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
import {
  classifyTrust,
  isTrustedPullRequest,
  type RepositoryPermission,
  type TrustClassification,
} from "./trust.js";

export interface ActionIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readDiff(baseSha: string, headSha: string): Promise<string>;
  readPolicy(revision: string, path: string): Promise<string | undefined>;
  readPullRequest?(
    repository: string,
    pullRequestNumber: number,
  ): Promise<ReviewRequestPullRequest>;
  readCheckoutHead?(): Promise<string>;
  readPermission?(repository: string, actor: string): Promise<RepositoryPermission>;
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
  /** Releases resources held for the run, such as a credential-store pool. */
  close?(): Promise<void>;
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

export async function createActionIo(env: NodeJS.ProcessEnv): Promise<ActionIo> {
  const token = env.GITHUB_TOKEN;
  delete env.GITHUB_TOKEN;
  const credentials = await resolveActionCredentials(env);
  // GITHUB_REPOSITORY is set by the runner from the workflow's own repository;
  // no event payload or input can change it. runAction later refuses any event
  // whose base repository disagrees with it.
  const workflowRepository = env.GITHUB_REPOSITORY;
  const transport =
    token === undefined || workflowRepository === undefined
      ? undefined
      : createGitHubTransport(
          token,
          { repository: workflowRepository, role: "review" },
          env.GITHUB_API_URL,
        );
  return {
    credentialProfiles: credentials.profiles,
    close: credentials.close,
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
          readPermission: (repository: string, actor: string) =>
            readRepositoryPermission(transport, repository, actor),
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

interface ActionPersistenceSelection {
  persistence?: ReviewPersistenceStore | undefined;
  configurationReason?: string | undefined;
}

function filesystemPersistence(stateDirectory: string | undefined): ActionPersistenceSelection {
  if (stateDirectory === undefined || stateDirectory === "") return {};
  return { persistence: new FileSystemReviewPersistenceStore(stateDirectory) };
}

function githubHostedPersistence(io: ActionIo): ActionPersistenceSelection {
  if (io.gitPersistence !== undefined && io.publishOutcome !== undefined) {
    return { persistence: io.gitPersistence };
  }
  return {
    configurationReason:
      "The default GitHub-hosted Action requires GITHUB_TOKEN with permissions: contents: write and pull-requests: write so durable Git state and GitHub publication are available. Diffowl does not fall back to filesystem state or partial publication.",
  };
}

function selfHostedPersistence(stateDirectory: string | undefined): ActionPersistenceSelection {
  if (stateDirectory !== undefined && stateDirectory !== "") {
    return { persistence: new FileSystemReviewPersistenceStore(stateDirectory) };
  }
  return {
    configurationReason:
      "A self-hosted Action run requires the self-hosted-state-directory input to name a trusted durable filesystem directory. Diffowl does not fall back to ephemeral state.",
  };
}

function actionPersistence(
  env: NodeJS.ProcessEnv,
  trust: ReturnType<typeof classifyTrust>,
  io: ActionIo,
): ActionPersistenceSelection {
  const stateDirectory = (
    env["INPUT_SELF-HOSTED-STATE-DIRECTORY"] ?? env.INPUT_SELF_HOSTED_STATE_DIRECTORY
  )?.trim();
  if (env.GITHUB_ACTIONS !== "true" || !isTrustedPullRequest(trust)) {
    return filesystemPersistence(stateDirectory);
  }
  if (env.RUNNER_ENVIRONMENT === "github-hosted") return githubHostedPersistence(io);
  if (env.RUNNER_ENVIRONMENT === "self-hosted") {
    return selfHostedPersistence(stateDirectory);
  }
  return {
    configurationReason:
      "RUNNER_ENVIRONMENT must identify a github-hosted or self-hosted runner before Diffowl can select durable Finding state.",
  };
}

async function configurationFailureOutcome(
  io: ActionIo,
  event: GitHubPullRequestEvent,
  trust: ReturnType<typeof classifyTrust>,
  reason: string,
): Promise<ReviewOutcome> {
  const outcome: ReviewOutcome = {
    type: "configuration_failure",
    pullRequest: {
      repository: event.repository.full_name,
      number: event.pull_request.number,
      baseSha: event.pull_request.base.sha,
      headSha: event.pull_request.head.sha,
    },
    policySource: {
      type: "trusted_base_branch",
      revision: event.pull_request.base.sha,
      path: PROJECT_POLICY_PATH,
    },
    reason,
    trust,
  };
  await setReviewOutputs(io, outcome);
  await recordNotAttemptedPublication(io, outcome);
  return outcome;
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

/**
 * Trust for a fork head depends on the base-branch policy and the author's
 * base-repository permission. Both are read here, before any provider
 * credential or validation command is reachable: the policy from the base
 * revision so the pull request cannot grant itself trust, the permission from
 * the collaborators API so the fork location proves nothing on its own.
 */
async function classifyActionTrust(
  env: NodeJS.ProcessEnv,
  io: ActionIo,
  event: GitHubPullRequestEvent,
): Promise<TrustClassification> {
  const { pull_request: pullRequest, repository } = event;
  const base = {
    type: "github_pull_request" as const,
    repository: repository.full_name,
    headRepository: pullRequest.head.repo.full_name,
    actor: pullRequest.user?.login,
  };
  if (pullRequest.head.repo.full_name === repository.full_name) return classifyTrust(base);
  const policy = parseProjectPolicy(await io.readPolicy(pullRequest.base.sha, PROJECT_POLICY_PATH));
  const forksTrusted = policy.valid && collaboratorForksTrusted(policy.policy);
  const author = pullRequest.user?.login;
  if (!forksTrusted || author === undefined || io.readPermission === undefined) {
    return classifyTrust({ ...base, collaboratorForksTrusted: forksTrusted });
  }
  return classifyTrust({
    ...base,
    collaboratorForksTrusted: true,
    authorPermission: await io.readPermission(repository.full_name, author),
  });
}

// oxlint-disable-next-line complexity, max-lines-per-function
export async function runAction(env: NodeJS.ProcessEnv, io?: ActionIo): Promise<ReviewOutcome> {
  io ??= await createActionIo(env);
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

  const trust = await classifyActionTrust(env, io, event);

  const persistenceSelection = actionPersistence(env, trust, io);
  if (persistenceSelection.configurationReason !== undefined) {
    return configurationFailureOutcome(io, event, trust, persistenceSelection.configurationReason);
  }
  const persistence = persistenceSelection.persistence;
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
          rootSurface:
            request.rootCommentId === request.eventId ? "issue_comment" : "review_comment",
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
