import { describe, expect, it } from "vitest";

import { createGitHubTransport } from "../src/github-publication.js";
import { GitHubScopeError, assertInScope, scopeSurface } from "../src/github-scope.js";
import { GitScopeError, assertPushInScope } from "../src/git-state-persistence.js";

const review = { repository: "example/review-target", role: "review" as const };
const router = { repository: "example/review-target", role: "router" as const };
const repo = "/repos/example/review-target";

/** Returns "<method> <path>: refused" when scope throws, or ": allowed" otherwise, so failures name the call. */
function refusal(
  scope: typeof review | typeof router,
  request: { method: string; path: string; body?: unknown },
): string {
  try {
    assertInScope(scope, request);
    return `${request.method} ${request.path}: allowed`;
  } catch (error) {
    return error instanceof GitHubScopeError
      ? `${request.method} ${request.path}: refused`
      : `${request.method} ${request.path}: ${String(error)}`;
  }
}

function pushRefusal(args: string[]): string {
  try {
    assertPushInScope(args);
    return `${args.join(" ")}: allowed`;
  } catch (error) {
    return error instanceof GitScopeError ? `${args.join(" ")}: refused` : String(error);
  }
}

describe("GitHub token scope", () => {
  it("allows exactly the review surface on the bound repository", () => {
    const allowed: Array<[string, string]> = [
      ["GET", `${repo}/pulls/42`],
      ["GET", `${repo}/pulls/42/reviews?per_page=100&page=1`],
      ["GET", `${repo}/pulls/42/comments?per_page=100&page=2`],
      ["GET", `${repo}/issues/42/comments?per_page=100&page=1`],
      ["GET", `${repo}/collaborators/alice/permission`],
      ["GET", `${repo}/collaborators/dependabot%5Bbot%5D/permission`.replace("%5Bbot%5D", "[bot]")],
      ["POST", `${repo}/pulls/42/reviews`],
      ["POST", `${repo}/pulls/42/comments`],
      ["POST", `${repo}/pulls/42/comments/7/replies`],
      ["POST", `${repo}/issues/42/comments`],
    ];
    for (const [method, path] of allowed) {
      expect(() => assertInScope(review, { method, path })).not.toThrow();
    }
  });

  it("refuses another repository, another resource, and write methods it never uses", () => {
    const refused: Array<[string, string]> = [
      ["GET", "/repos/example/other-repo/pulls/42"],
      ["GET", "/repos/example/review-target-2/pulls/42"],
      ["GET", "/user"],
      ["GET", `${repo}`],
      ["GET", `${repo}/contents/README.md`],
      ["GET", `${repo}/actions/secrets`],
      ["POST", `${repo}/git/refs`],
      ["PATCH", `${repo}/git/refs/heads/main`],
      ["DELETE", `${repo}/pulls/42/comments/7`],
      ["POST", `${repo}/pulls/42/merge`],
      ["PUT", `${repo}/pulls/42/merge`],
      ["POST", `${repo}/releases`],
      ["POST", `${repo}/issues`],
      ["PATCH", `${repo}/issues/42`],
      ["POST", `${repo}/check-runs`],
      ["POST", `${repo}/actions/workflows/review-owl.yml/dispatches`],
      ["POST", `${repo}/pulls/../../other/pulls/42/reviews`],
      ["GET", `${repo}/pulls/42/reviews?per_page=100&page=1#/../x`],
    ];
    for (const [method, path] of refused) {
      expect(refusal(review, { method, path })).toBe(`${method} ${path}: refused`);
    }
  });
});

describe("GitHub token scope: roles and GraphQL", () => {
  it("gives the router its reactions and dispatch, but not review publication", () => {
    expect(() =>
      assertInScope(router, { method: "POST", path: `${repo}/issues/comments/9/reactions` }),
    ).not.toThrow();
    expect(() =>
      assertInScope(router, {
        method: "POST",
        path: `${repo}/actions/workflows/review-owl.yml/dispatches`,
      }),
    ).not.toThrow();
    expect(() =>
      assertInScope(router, { method: "POST", path: `${repo}/pulls/42/reviews` }),
    ).toThrow(GitHubScopeError);
    expect(() =>
      assertInScope(router, {
        method: "POST",
        path: "/graphql",
        body: { query: "query DiffowlFindingThread { x }" },
      }),
    ).toThrow(GitHubScopeError);
  });

  it("allows only the named GraphQL operations, one per document", () => {
    const ok = (query: string) =>
      assertInScope(review, { method: "POST", path: "/graphql", body: { query } });
    expect(
      ok("query DiffowlFindingThread($owner: String!) { repository(owner: $owner) { id } }"),
    ).toBe("graphql DiffowlFindingThread");
    expect(
      ok(
        "mutation DiffowlResolveFinding($threadId: ID!) { resolveReviewThread(input: {threadId: $threadId}) { thread { id } } }",
      ),
    ).toBe("graphql DiffowlResolveFinding");
    for (const query of [
      'mutation DeleteEverything { deleteRef(input: {refId: "x"}) { clientMutationId } }',
      "mutation DiffowlResolveFinding { x } mutation Other { y }",
      "query DiffowlFindingThread { x } mutation DiffowlResolveFinding { y }",
      "{ viewer { login } }",
      "",
    ]) {
      expect(refusal(review, { method: "POST", path: "/graphql", body: { query } })).toBe(
        "POST /graphql: refused",
      );
    }
    expect(() => assertInScope(review, { method: "GET", path: "/graphql" })).toThrow(
      GitHubScopeError,
    );
  });
});

describe("GitHub token scope: transport", () => {
  it("checks scope before the token is attached to any request", async () => {
    const originalFetch = globalThis.fetch;
    let fetched = false;
    globalThis.fetch = async () => {
      fetched = true;
      return new Response("{}", { status: 200 });
    };
    try {
      await expect(
        createGitHubTransport(
          "secret-token",
          review,
        )({
          method: "POST",
          path: `${repo}/git/refs`,
          body: { ref: "refs/heads/main", sha: "0".repeat(40) },
        }),
      ).rejects.toThrow(GitHubScopeError);
      expect(fetched).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("publishes the surface it enforces", () => {
    const surface = scopeSurface("review");
    expect(surface.map((entry) => entry.name)).toContain("publish pull-request review");
    expect(surface.some((entry) => entry.method === "PATCH" || entry.method === "DELETE")).toBe(
      false,
    );
    expect(scopeSurface("router").map((entry) => entry.name)).toContain("dispatch review workflow");
  });
});

describe("git state push scope", () => {
  const state = "refs/diffowl/state/repositories/example/review-target/pull-requests/42/state";

  it("allows the atomic state push and the dry-run permission probe", () => {
    expect(() =>
      assertPushInScope([
        "push",
        "--atomic",
        "origin",
        `abc:${state}`,
        `abc:refs/diffowl/state/marker`,
      ]),
    ).not.toThrow();
    expect(() =>
      assertPushInScope(["push", "--dry-run", "origin", "abc:refs/diffowl/state/access-check/x"]),
    ).not.toThrow();
    expect(() =>
      assertPushInScope(["fetch", "origin", "+refs/heads/*:refs/remotes/origin/*"]),
    ).not.toThrow();
  });

  it("refuses force, deletion, branch and tag destinations, and non-atomic writes", () => {
    for (const args of [
      ["push", "--atomic", "--force", "origin", `abc:${state}`],
      ["push", "--atomic", "-f", "origin", `abc:${state}`],
      ["push", "--atomic", "--force-with-lease=x", "origin", `abc:${state}`],
      ["push", "--atomic", "origin", `+abc:${state}`],
      ["push", "--atomic", "--delete", "origin", state],
      ["push", "--atomic", "origin", "abc:refs/heads/main"],
      ["push", "--atomic", "origin", "abc:refs/tags/v0"],
      ["push", "--atomic", "origin", "abc:refs/diffowl/other/x"],
      ["push", "--atomic", "origin", `abc:${state}`, "abc:refs/heads/main"],
      ["push", "--atomic", "--tags", "origin"],
      ["push", "--mirror", "origin"],
      ["push", "origin", `abc:${state}`],
    ]) {
      expect(pushRefusal(args)).toBe(`${args.join(" ")}: refused`);
    }
  });
});
