import { readFile } from "node:fs/promises";

import { createGitHubTransport } from "./github-publication.js";
import { createGitHubReviewRequestIo } from "./github-review-request.js";
import { GitReviewPersistenceStore } from "./git-state-persistence.js";
import { readGitFileAtRevision } from "./git-read.js";
import { PROJECT_POLICY_PATH } from "./project-policy.js";
import { routeReviewRequest, type ReviewRequestEvent } from "./review-request.js";

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
  };
}

try {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const token = process.env.GITHUB_TOKEN;
  if (eventPath === undefined) throw new Error("GITHUB_EVENT_PATH is required.");
  if (token === undefined || token === "") throw new Error("GITHUB_TOKEN is required.");
  const event = parseIssueCommentEvent(JSON.parse(await readFile(eventPath, "utf8")));
  if (event === undefined) throw new Error("The GitHub event is not a pull-request issue comment.");
  const transport = createGitHubTransport(token, process.env.GITHUB_API_URL);
  delete process.env.GITHUB_TOKEN;
  const workflow = (process.env.INPUT_WORKFLOW ?? "review-owl.yml").trim();
  if (workflow === "") throw new Error("The Review workflow input must not be empty.");
  const result = await routeReviewRequest(
    event,
    createGitHubReviewRequestIo(transport, {
      repository: event.repository,
      pullRequestNumber: event.pullRequestNumber,
      workflow,
      readPolicy: (revision) => readGitFileAtRevision(revision, PROJECT_POLICY_PATH),
    }),
    new GitReviewPersistenceStore({ token }),
  );
  if (result.type !== "ignored") process.stdout.write(`${JSON.stringify(result)}\n`);
  if (result.type === "dispatched" && result.deprecatedAlias) {
    process.stdout.write(
      "::warning::/diffowl rerun is deprecated; use /diffowl review. Both use the same Review request path.\n",
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Review OWL request router failed: ${message}\n`);
  process.exitCode = 1;
}
