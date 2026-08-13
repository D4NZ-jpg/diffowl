import { decodeGitPath } from "./review-orchestration.js";

export interface ChangedLine {
  path: string;
  line: number;
}

function headerPath(line: string): string | undefined {
  const value = line.slice(4).split("\t", 1)[0] ?? "";
  if (value === "/dev/null") return undefined;
  return decodeGitPath(value);
}

// A unified-diff state machine necessarily branches on headers, hunks, and line prefixes.
// oxlint-disable-next-line complexity
export function addedLinesFromDiff(diff: string): ChangedLine[] {
  const changed: ChangedLine[] = [];
  let path: string | undefined;
  let headLine: number | undefined;
  let inHunk = false;

  for (const line of diff.split("\n")) {
    if (!inHunk && line.startsWith("+++ ")) {
      path = headerPath(line);
      headLine = undefined;
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk !== null) {
      headLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      path = undefined;
      headLine = undefined;
      inHunk = false;
      continue;
    }
    if (path === undefined || headLine === undefined || line.startsWith("\\")) continue;
    const prefix = line[0];
    if (prefix === "+") changed.push({ path, line: headLine });
    if (prefix !== "-") headLine += 1;
  }
  return changed;
}
