import { expect, it } from "vitest";

import { addedLinesFromDiff } from "../src/github-diff.js";

it("extracts additions across files, hunks, and deletions", () => {
  const diff = [
    "diff --git a/src/file.ts b/src/file.ts",
    "--- a/src/file.ts",
    "+++ b/src/file.ts",
    "@@ -4,3 +4,4 @@",
    " context",
    "-deleted",
    "+added",
    "+another",
    " context",
    "@@ -20 +21,2 @@",
    "-old",
    "+new",
    "+newer",
    "diff --git a/gone.ts b/gone.ts",
    "--- a/gone.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-gone",
    "diff --git a/next.ts b/next.ts",
    "--- a/next.ts",
    "+++ b/next.ts",
    "@@ -0,0 +1 @@",
    "+next",
  ].join("\n");

  expect(addedLinesFromDiff(diff)).toEqual([
    { path: "src/file.ts", line: 5 },
    { path: "src/file.ts", line: 6 },
    { path: "src/file.ts", line: 21 },
    { path: "src/file.ts", line: 22 },
    { path: "next.ts", line: 1 },
  ]);
});

it("does not mistake added content beginning with plus signs for a file header", () => {
  const diff = [
    "diff --git a/readme.md b/readme.md",
    "--- a/readme.md",
    "+++ b/readme.md",
    "@@ -0,0 +1,2 @@",
    "+++ literal content",
    "+tail",
  ].join("\n");

  expect(addedLinesFromDiff(diff)).toEqual([
    { path: "readme.md", line: 1 },
    { path: "readme.md", line: 2 },
  ]);
});

it("decodes Git quoted paths including whitespace, quotes, and octal UTF-8 bytes", () => {
  const diff = [
    'diff --git "a/src/name\\t\\\".ts" "b/src/name\\t\\\".ts"',
    '--- "a/src/name\\t\\\".ts"',
    '+++ "b/src/name\\t\\\".ts"',
    "@@ -0,0 +1 @@",
    "+quoted",
    'diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"',
    '--- "a/src/caf\\303\\251.ts"',
    '+++ "b/src/caf\\303\\251.ts"',
    "@@ -0,0 +3 @@",
    "+utf8",
    "diff --git a/src/space name.ts b/src/space name.ts",
    "--- a/src/space name.ts",
    "+++ b/src/space name.ts",
    "@@ -0,0 +2 @@",
    "+space",
  ].join("\n");

  expect(addedLinesFromDiff(diff)).toEqual([
    { path: 'src/name\t".ts', line: 1 },
    { path: "src/café.ts", line: 3 },
    { path: "src/space name.ts", line: 2 },
  ]);
});
