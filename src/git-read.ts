import { execFile } from "node:child_process";

export function readGitFileAtRevision(revision: string, path: string): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["show", `${revision}:${path}`],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve(stdout);
          return;
        }
        if (stderr.includes("does not exist in") || stderr.includes("exists on disk, but not in")) {
          resolve(undefined);
          return;
        }
        reject(error);
      },
    );
  });
}
