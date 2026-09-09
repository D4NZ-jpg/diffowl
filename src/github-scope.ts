/**
 * Runtime guard on what the GitHub token may be used for.
 *
 * The workflow token can carry permissions well beyond one pull request:
 * `contents: write` covers every branch, `pull-requests: write` covers every
 * pull request. Diffowl needs a small, fixed surface on a single repository.
 * This module makes that surface a property of the transport rather than of
 * the code that happens to call it, so a new call site, a bug, or poisoned
 * model output cannot reach anything else even when the token would allow it.
 *
 * The scope binds one repository (`owner/name`) and an allowlist of
 * method + path shapes, each with a name that appears in refusal messages.
 * GraphQL is allowed only for the named operations, and mutations are
 * matched on their operation name so a query cannot smuggle a different one.
 */

export type GitHubScopeRole = "review" | "router";

export interface GitHubScope {
  repository: string;
  role: GitHubScopeRole;
}

export class GitHubScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubScopeError";
  }
}

interface Rule {
  name: string;
  method: "GET" | "POST";
  /** Path regex, matched against the path with the repository segment already verified. */
  path: RegExp;
  roles: readonly GitHubScopeRole[];
}

const number = String.raw`\d+`;
const page = String.raw`(?:\?[A-Za-z0-9_=&\-]*)?`;

// Ordered list; the first matching rule names the call. Every path below the
// repository is anchored and takes only numeric identifiers or a fixed literal.
const rules: readonly Rule[] = [
  {
    name: "read pull request",
    method: "GET",
    path: new RegExp(`^/pulls/${number}$`),
    roles: ["review", "router"],
  },
  {
    name: "list pull-request reviews",
    method: "GET",
    path: new RegExp(`^/pulls/${number}/reviews${page}$`),
    roles: ["review"],
  },
  {
    name: "list review comments",
    method: "GET",
    path: new RegExp(`^/pulls/${number}/comments${page}$`),
    roles: ["review", "router"],
  },
  {
    name: "read review comment",
    method: "GET",
    path: new RegExp(`^/pulls/comments/${number}$`),
    roles: ["router"],
  },
  {
    name: "list issue comments",
    method: "GET",
    path: new RegExp(`^/issues/${number}/comments${page}$`),
    roles: ["review", "router"],
  },
  {
    name: "read collaborator permission",
    method: "GET",
    path: /^\/collaborators\/[A-Za-z0-9-]+(?:\[bot\])?\/permission$/u,
    roles: ["review", "router"],
  },
  {
    name: "publish pull-request review",
    method: "POST",
    path: new RegExp(`^/pulls/${number}/reviews$`),
    roles: ["review"],
  },
  {
    name: "post review comment",
    method: "POST",
    path: new RegExp(`^/pulls/${number}/comments$`),
    roles: ["review"],
  },
  {
    name: "reply to review comment",
    method: "POST",
    path: new RegExp(`^/pulls/${number}/comments/${number}/replies$`),
    roles: ["review", "router"],
  },
  {
    name: "post issue comment",
    method: "POST",
    path: new RegExp(`^/issues/${number}/comments$`),
    roles: ["review", "router"],
  },
  {
    name: "react to issue comment",
    method: "POST",
    path: new RegExp(`^/issues/comments/${number}/reactions$`),
    roles: ["router"],
  },
  {
    name: "react to review comment",
    method: "POST",
    path: new RegExp(`^/pulls/comments/${number}/reactions$`),
    roles: ["router"],
  },
  {
    name: "dispatch review workflow",
    method: "POST",
    path: /^\/actions\/workflows\/[A-Za-z0-9._%-]+\/dispatches$/u,
    roles: ["router"],
  },
];

const graphqlOperations: Record<GitHubScopeRole, readonly string[]> = {
  review: ["DiffowlFindingThread", "DiffowlResolveFinding", "DiffowlReopenFinding"],
  router: [],
};

const encodedRepository = (repository: string) =>
  repository
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

function graphqlOperationName(body: unknown): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const query = (body as { query?: unknown }).query;
  if (typeof query !== "string") return undefined;
  const match = /^\s*(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[({]/u.exec(query);
  if (match === null) return undefined;
  // One operation per document: a second `query`/`mutation` keyword is refused.
  const keywords = query.match(/\b(?:query|mutation)\s+[A-Za-z_]/gu) ?? [];
  return keywords.length === 1 ? match[1] : undefined;
}

/**
 * Throws {@link GitHubScopeError} unless the request is on the allowlist for
 * the scope's repository and role. Returns the rule name otherwise, which the
 * transport can log.
 */
export function assertInScope(
  scope: GitHubScope,
  request: { method: string; path: string; body?: unknown },
): string {
  if (request.path === "/graphql") {
    if (request.method !== "POST") throw new GitHubScopeError("GraphQL requires POST.");
    const operation = graphqlOperationName(request.body);
    if (operation === undefined || !graphqlOperations[scope.role].includes(operation)) {
      throw new GitHubScopeError(
        `GraphQL operation ${operation ?? "(unnamed or multiple)"} is outside the ${scope.role} scope.`,
      );
    }
    return `graphql ${operation}`;
  }
  const prefix = `/repos/${encodedRepository(scope.repository)}`;
  if (!request.path.startsWith(`${prefix}/`)) {
    throw new GitHubScopeError(
      `Request ${request.method} ${request.path} is outside repository ${scope.repository}.`,
    );
  }
  const rest = request.path.slice(prefix.length);
  const rule = rules.find(
    (candidate) =>
      candidate.method === request.method &&
      candidate.roles.includes(scope.role) &&
      candidate.path.test(rest),
  );
  if (rule === undefined) {
    throw new GitHubScopeError(
      `Request ${request.method} ${request.path} is not on the ${scope.role} allowlist.`,
    );
  }
  return rule.name;
}

/** The allowlist, for documentation and tests. */
export function scopeSurface(
  role: GitHubScopeRole,
): Array<{ name: string; method: string; path: string }> {
  return [
    ...rules
      .filter((rule) => rule.roles.includes(role))
      .map((rule) => ({
        name: rule.name,
        method: rule.method,
        path: `/repos/{repository}${rule.path.source}`,
      })),
    ...graphqlOperations[role].map((operation) => ({
      name: `graphql ${operation}`,
      method: "POST",
      path: "/graphql",
    })),
  ];
}
