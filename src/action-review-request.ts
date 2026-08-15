import { type GitHubPullRequestEvent, isPullRequestEvent } from "./action-event.js";
import type { ReviewPersistenceStore } from "./persistence.js";
import {
  claimReviewRequest,
  completeReviewRequest,
  reviewRequestIsActive,
  type ReviewRequestPullRequest,
} from "./review-request.js";

interface ActionRequestIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  readPullRequest?(
    repository: string,
    pullRequestNumber: number,
  ): Promise<ReviewRequestPullRequest>;
  readCheckoutHead?(): Promise<string>;
}

export type ActionEventResolution =
  | { valid: true; eventName: "pull_request" | "workflow_dispatch"; event: GitHubPullRequestEvent }
  | { valid: false; type: "policy_skip" | "unsupported_change"; reason: string };

interface DispatchInputs {
  repository: string;
  pullRequestNumber: number;
  baseSha: string;
  headSha: string;
}

function actionInput(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[`INPUT_${name}`] ?? env[`INPUT_${name.replaceAll("-", "_")}`];
}

function nonEmpty(value: string | undefined): value is string {
  return value !== undefined && value !== "";
}

function dispatchInputs(env: NodeJS.ProcessEnv): DispatchInputs | undefined {
  const repository = actionInput(env, "REPOSITORY")?.trim();
  const pullRequestNumber = Number(actionInput(env, "PULL-REQUEST-NUMBER"));
  const baseSha = actionInput(env, "BASE-SHA")?.trim();
  const headSha = actionInput(env, "HEAD-SHA")?.trim();
  if (![repository, baseSha, headSha].every(nonEmpty)) return undefined;
  if (!Number.isInteger(pullRequestNumber) || pullRequestNumber <= 0) return undefined;
  return { repository: repository!, pullRequestNumber, baseSha: baseSha!, headSha: headSha! };
}

function matchesDispatch(pullRequest: ReviewRequestPullRequest, inputs: DispatchInputs): boolean {
  return (
    pullRequest.number === inputs.pullRequestNumber &&
    pullRequest.baseRepository === inputs.repository &&
    pullRequest.headRepository === inputs.repository &&
    pullRequest.baseSha === inputs.baseSha &&
    pullRequest.headSha === inputs.headSha
  );
}

async function resolveWorkflowDispatch(
  env: NodeJS.ProcessEnv,
  io: ActionRequestIo,
): Promise<ActionEventResolution> {
  const inputs = dispatchInputs(env);
  if (inputs === undefined) {
    return {
      valid: false,
      type: "policy_skip",
      reason:
        "A workflow dispatch requires repository, pull-request-number, base-sha, and head-sha inputs.",
    };
  }
  if (io.readPullRequest === undefined || io.readCheckoutHead === undefined) {
    return {
      valid: false,
      type: "policy_skip",
      reason: "The Action cannot verify a workflow-dispatch pull request.",
    };
  }
  const pullRequest = await io.readPullRequest(inputs.repository, inputs.pullRequestNumber);
  if (!matchesDispatch(pullRequest, inputs)) {
    return {
      valid: false,
      type: "policy_skip",
      reason: "The workflow dispatch does not match the latest same-repository head.",
    };
  }
  if ((await io.readCheckoutHead()) !== inputs.headSha) {
    return {
      valid: false,
      type: "policy_skip",
      reason: "The workflow checkout does not match the verified pull-request head.",
    };
  }
  return {
    valid: true,
    eventName: "workflow_dispatch",
    event: {
      repository: { full_name: inputs.repository },
      pull_request: {
        number: inputs.pullRequestNumber,
        base: { sha: pullRequest.baseSha, repo: { full_name: pullRequest.baseRepository } },
        head: { sha: pullRequest.headSha, repo: { full_name: pullRequest.headRepository } },
        user: { login: pullRequest.author },
      },
    },
  };
}

async function resolvePullRequest(
  env: NodeJS.ProcessEnv,
  io: ActionRequestIo,
): Promise<ActionEventResolution> {
  const eventPath = env.GITHUB_EVENT_PATH;
  if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH is required.");
  const candidate: unknown = JSON.parse(await io.readFile(eventPath, "utf8"));
  return isPullRequestEvent(candidate)
    ? { valid: true, eventName: "pull_request", event: candidate }
    : {
        valid: false,
        type: "unsupported_change",
        reason: "The GitHub event is not a supported pull-request event.",
      };
}

export async function resolveActionEvent(
  env: NodeJS.ProcessEnv,
  io: ActionRequestIo,
): Promise<ActionEventResolution> {
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") return resolveWorkflowDispatch(env, io);
  if (env.GITHUB_EVENT_NAME === "pull_request") return resolvePullRequest(env, io);
  return {
    valid: false,
    type: "policy_skip",
    reason: `GitHub event "${env.GITHUB_EVENT_NAME ?? "unknown"}" is not a safe pull_request context.`,
  };
}

export interface ClaimedReviewRequest {
  eventId: string;
  workflowRunId: string;
}

export async function claimActionReviewRequest(
  env: NodeJS.ProcessEnv,
  event: GitHubPullRequestEvent,
  persistence: ReviewPersistenceStore | undefined,
): Promise<ClaimedReviewRequest | false | undefined> {
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") return undefined;
  const eventId = actionInput(env, "REVIEW-REQUEST-EVENT-ID")?.trim();
  const workflowRunId = env.GITHUB_RUN_ID?.trim();
  if (
    persistence === undefined ||
    eventId === undefined ||
    eventId === "" ||
    workflowRunId === undefined ||
    workflowRunId === ""
  ) {
    return false;
  }
  const pullRequest = event.pull_request;
  const accepted = await claimReviewRequest(
    persistence,
    { repository: event.repository.full_name, pullRequestNumber: pullRequest.number },
    eventId,
    pullRequest.head.sha,
    workflowRunId,
  );
  return accepted ? { eventId, workflowRunId } : false;
}

export async function actionReviewRequestIsActive(
  event: GitHubPullRequestEvent,
  persistence: ReviewPersistenceStore | undefined,
  request: ClaimedReviewRequest | false | undefined,
): Promise<boolean> {
  if (request === undefined) return true;
  if (persistence === undefined || request === false) return false;
  return reviewRequestIsActive(
    persistence,
    {
      repository: event.repository.full_name,
      pullRequestNumber: event.pull_request.number,
    },
    request.eventId,
    request.workflowRunId,
  );
}

export async function completeActionReviewRequest(
  event: GitHubPullRequestEvent,
  persistence: ReviewPersistenceStore | undefined,
  request: ClaimedReviewRequest | false | undefined,
): Promise<void> {
  if (persistence === undefined || request === undefined || request === false) return;
  await completeReviewRequest(
    persistence,
    {
      repository: event.repository.full_name,
      pullRequestNumber: event.pull_request.number,
    },
    request.eventId,
    request.workflowRunId,
  );
}
