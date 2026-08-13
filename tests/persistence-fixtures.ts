import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function temporaryStateDirectories(prefix: string) {
  const paths: string[] = [];
  return {
    create: async () => {
      const path = await mkdtemp(join(tmpdir(), prefix));
      paths.push(path);
      return path;
    },
    removeAll: async () => {
      await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    },
  };
}

export async function persistedRunCount(stateDirectory: string): Promise<number> {
  const manifest = JSON.parse(
    await readFile(
      join(stateDirectory, "repositories/example/review-target/pull-requests/42/manifest.json"),
      "utf8",
    ),
  ) as { runs: Record<string, string> };
  return Object.keys(manifest.runs).length;
}
