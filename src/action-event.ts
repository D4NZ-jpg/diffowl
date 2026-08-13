export interface GitHubPullRequestEvent {
  repository: { full_name: string };
  pull_request: {
    number: number;
    base: { sha: string; repo: { full_name: string } };
    head: { sha: string; repo: { full_name: string } };
    user?: { login: string };
  };
}

function isRepository(value: unknown): value is { full_name: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).full_name === "string"
  );
}

function isRef(value: unknown): value is { sha: string; repo: { full_name: string } } {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return typeof ref.sha === "string" && isRepository(ref.repo);
}

export function isPullRequestEvent(value: unknown): value is GitHubPullRequestEvent {
  if (typeof value !== "object" || value === null) return false;
  const event = value as Record<string, unknown>;
  if (!isRepository(event.repository)) return false;
  if (typeof event.pull_request !== "object" || event.pull_request === null) return false;
  const pullRequest = event.pull_request as Record<string, unknown>;
  return (
    typeof pullRequest.number === "number" &&
    Number.isInteger(pullRequest.number) &&
    isRef(pullRequest.base) &&
    isRef(pullRequest.head)
  );
}
