import { describe, expect, it } from "vitest";

import { GitArgumentError, assertObjectId, assertRepositoryPath } from "../src/git-args.js";
import { readGitFileAtRevision } from "../src/git-read.js";

const sha = "a".repeat(40);

function outcome(check: (value: string) => string, value: string): string {
  try {
    check(value);
    return `${JSON.stringify(value)}: allowed`;
  } catch (error) {
    return error instanceof GitArgumentError ? `${JSON.stringify(value)}: refused` : String(error);
  }
}

describe("git argument guards", () => {
  it("accepts full hex object ids and plain relative paths", () => {
    expect(assertObjectId(sha)).toBe(sha);
    expect(assertObjectId("0123456789abcdef".repeat(4))).toHaveLength(64);
    for (const path of ["src/a.ts", ".diffowl.json", "a b/c.txt", "deep/er/path/file"]) {
      expect(assertRepositoryPath(path)).toBe(path);
    }
  });

  it("refuses anything git could read as an option or a revision expression", () => {
    for (const value of [
      "--output=/tmp/x",
      "-p",
      "HEAD",
      "main",
      `${sha}~1`,
      `${sha}^{tree}`,
      ":/fixup",
      "refs/heads/main",
      "A".repeat(40),
      sha.slice(0, 39),
      `${sha} `,
      "",
    ]) {
      expect(outcome(assertObjectId, value)).toBe(`${JSON.stringify(value)}: refused`);
    }
    for (const value of [
      "--output=/tmp/x",
      "-",
      "/etc/passwd",
      "C:\\Windows\\win.ini",
      "../secrets",
      "src/../../x",
      "src//x",
      "src/./x",
      "HEAD:src/x",
      "a\0b",
      "",
    ]) {
      expect(outcome(assertRepositoryPath, value)).toBe(`${JSON.stringify(value)}: refused`);
    }
  });

  it("rejects an option-shaped revision before git ever runs", async () => {
    await expect(readGitFileAtRevision("--output=/tmp/pwn", ".diffowl.json")).rejects.toThrow(
      GitArgumentError,
    );
    await expect(readGitFileAtRevision(sha, "--output=/tmp/pwn")).rejects.toThrow(GitArgumentError);
  });
});
