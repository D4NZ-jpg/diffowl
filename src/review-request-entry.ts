import { readFile } from "node:fs/promises";

import { routeFindingCommand, type FindingCommandEvent } from "./finding-command.js";
import { createGitHubFindingCommandIo } from "./github-finding-command.js";
import { createGitHubTransport } from "./github-publication.js";
import { createGitHubReviewRequestIo } from "./github-review-request.js";
import { GitReviewPersistenceStore } from "./git-state-persistence.js";
import { readGitFileAtRevision } from "./git-read.js";
import { PROJECT_POLICY_PATH } from "./project-policy.js";
import { routeReviewRequest, type ReviewRequestEvent } from "./review-request.js";

function readProjectPolicy(revision: string): Promise<string | undefined> {
  return readGitFileAtRevision(revision, PROJECT_POLICY_PATH);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// oxlint-disable-next-line complexity
function parseIssueCommentEvent(value: unknown): ReviewRequestEvent | undefined {
  const event = record(value);
  const repository = record(event?.repository);
  const issue = record(event?.issue);
  const comment = record(event?.comment);
  const actor = record(comment?.user);
  const pullRequestNumber = issue?.number;
  if (
    typeof repository?.full_name !== "string" ||
    typeof repository.default_branch !== "string" ||
    !Number.isInteger(pullRequestNumber) ||
    record(issue?.pull_request) === undefined ||
    !(typeof comment?.id === "number" || typeof comment?.id === "string") ||
    typeof comment.body !== "string" ||
    typeof comment.created_at !== "string" ||
    typeof actor?.login !== "string"
  ) {
    return undefined;
  }
  return {
    eventId: String(comment.id),
    repository: repository.full_name,
    defaultBranch: repository.default_branch,
    pullRequestNumber: pullRequestNumber as number,
    actor: actor.login,
    body: comment.body,
    createdAt: comment.created_at,
  };
}

// oxlint-disable-next-line complexity
function parseReviewCommentEvent(value: unknown): FindingCommandEvent | undefined {
  const event = record(value);
  const repository = record(event?.repository);
  const pullRequest = record(event?.pull_request);
  const comment = record(event?.comment);
  const actor = record(comment?.user);
  const pullRequestNumber = pullRequest?.number;
  const commentId = comment?.id;
  const inReplyToId = comment?.in_reply_to_id;
  if (
    typeof repository?.full_name !== "string" ||
    typeof repository.default_branch !== "string" ||
    !Number.isInteger(pullRequestNumber) ||
    comment === undefined ||
    !(typeof commentId === "number" || typeof commentId === "string") ||
    typeof comment.body !== "string" ||
    typeof comment.created_at !== "string" ||
    typeof actor?.login !== "string" ||
    (inReplyToId !== undefined &&
      !(typeof inReplyToId === "number" || typeof inReplyToId === "string"))
  ) {
    return undefined;
  }
  return {
    id: String(commentId),
    repository: repository.full_name,
    defaultBranch: repository.default_branch,
    pullRequestNumber: pullRequestNumber as number,
    actor: actor.login,
    body: comment.body,
    createdAt: comment.created_at,
    ...(inReplyToId === undefined ? {} : { inReplyToId: String(inReplyToId) }),
  };
}

try {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH is required.");
  if (token === undefined || token === "") throw new Error("GITHUB_TOKEN is required.");
  const payload: unknown = JSON.parse(await readFile(eventPath, "utf8"));
  const issueEvent =
    process.env.GITHUB_EVENT_NAME === "issue_comment" ? parseIssueCommentEvent(payload) : undefined;
  const findingEvent =
    process.env.GITHUB_EVENT_NAME === "pull_request_review_comment"
      ? parseReviewCommentEvent(payload)
      : undefined;
  if (issueEvent === undefined && findingEvent === undefined) {
    throw new Error("The GitHub event is not a supported pull-request command comment.");
  }
  // Bind the transport to the runner's own repository, not the payload's.
  // GitHub writes both, but GITHUB_REPOSITORY cannot be influenced by any
  // event content; a payload that disagrees is refused outright.
  const repository = process.env.GITHUB_REPOSITORY;
  if (repository === undefined || repository === "")
    throw new Error("GITHUB_REPOSITORY is required.");
  if ((issueEvent ?? findingEvent)!.repository !== repository) {
    throw new Error("The event repository does not match the workflow repository.");
  }
  const transport = createGitHubTransport(
    token,
    { repository, role: "router" },
    process.env.GITHUB_API_URL,
  );
  delete process.env.GITHUB_TOKEN;
  const workflow = (process.env.INPUT_WORKFLOW ?? "review-owl.yml").trim();
  if (workflow === "") throw new Error("The Review workflow input must not be empty.");
  const persistence = new GitReviewPersistenceStore({ token });
  const result =
    findingEvent === undefined
      ? await routeReviewRequest(
          issueEvent!,
          createGitHubReviewRequestIo(transport, {
            repository: issueEvent!.repository,
            pullRequestNumber: issueEvent!.pullRequestNumber,
            workflow,
            readPolicy: readProjectPolicy,
          }),
          persistence,
        )
      : await routeFindingCommand(
          findingEvent,
          createGitHubFindingCommandIo(transport, {
            repository: findingEvent.repository,
            pullRequestNumber: findingEvent.pullRequestNumber,
            workflow,
            readPolicy: readProjectPolicy,
          }),
          persistence,
        );
  if (result.type !== "ignored") process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Review OWL request router failed: ${message}\n`);
  process.exitCode = 1;
}
