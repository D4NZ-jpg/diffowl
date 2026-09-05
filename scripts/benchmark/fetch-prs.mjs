#!/usr/bin/env node
// Fetch PR metadata and diff for each benchmark PR into inputs/<slug>.json
// in the shape `diffowl review --input` expects, and clone the repository at the
// PR head into checkouts/<slug> so the verifier can read files and run validation
// commands (both use process.cwd()). Requires `gh` to be logged in.
//
// Flags: --no-checkout   skip cloning (diff-only run)
//        --refetch       overwrite existing inputs
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const inputsDir = join(here, "inputs");
mkdirSync(inputsDir, { recursive: true });

const checkoutsDir = join(here, "checkouts");
mkdirSync(checkoutsDir, { recursive: true });
const flags = new Set(process.argv.slice(2));

const prs = JSON.parse(readFileSync(join(here, "prs.json"), "utf8"));
const failures = [];

function checkout(owner, repo, number, headSha, dir) {
  if (!existsSync(join(dir, ".git"))) {
    execFileSync("git", ["init", "-q", dir], { stdio: "inherit" });
    execFileSync("git", [
      "-C",
      dir,
      "remote",
      "add",
      "origin",
      `https://github.com/${owner}/${repo}.git`,
    ]);
  }
  const have = (() => {
    try {
      return (
        execFileSync("git", ["-C", dir, "rev-parse", "--verify", "-q", `${headSha}^{commit}`], {
          encoding: "utf8",
        }).trim() === headSha
      );
    } catch {
      return false;
    }
  })();
  if (!have) {
    // Fetch the PR head ref (works for merged and unmerged PRs) plus the merge base depth.
    execFileSync(
      "git",
      ["-C", dir, "fetch", "-q", "--depth", "50", "origin", `pull/${number}/head`],
      { stdio: "inherit" },
    );
  }
  execFileSync("git", ["-C", dir, "checkout", "-q", "--detach", headSha], { stdio: "inherit" });
}

for (const { url } of prs) {
  const [, owner, repo, number] = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  const slug = `${owner}__${repo}__${number}`;
  const inputPath = join(inputsDir, `${slug}.json`);
  try {
    if (existsSync(inputPath) && !flags.has("--refetch")) {
      const cached = JSON.parse(readFileSync(inputPath, "utf8"));
      if (!flags.has("--no-checkout"))
        checkout(owner, repo, number, cached.headSha, join(checkoutsDir, slug));
      console.log(
        `ok   ${slug} (cached input${flags.has("--no-checkout") ? "" : ", checkout ready"})`,
      );
      continue;
    }
    const meta = JSON.parse(
      execFileSync("gh", ["pr", "view", url, "--json", "baseRefOid,headRefOid,title"], {
        encoding: "utf8",
      }),
    );
    const diff = execFileSync("gh", ["pr", "diff", url], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    writeFileSync(
      inputPath,
      JSON.stringify(
        {
          repository: `${owner}/${repo}`,
          number: Number(number),
          baseSha: meta.baseRefOid,
          headSha: meta.headRefOid,
          diff,
          goldenUrl: url,
          title: meta.title,
        },
        null,
        2,
      ),
    );
    if (!flags.has("--no-checkout"))
      checkout(owner, repo, number, meta.headRefOid, join(checkoutsDir, slug));
    console.log(
      `ok   ${slug} (${diff.split("\n").length} diff lines${flags.has("--no-checkout") ? "" : ", checkout ready"})`,
    );
  } catch (error) {
    failures.push(slug);
    console.log(`FAIL ${slug}: ${String(error.message).split("\n")[0]}`);
  }
}

if (failures.length > 0) {
  console.log(
    `\n${failures.length} PR(s) could not be fetched; drop them from prs.json or replace them.`,
  );
  process.exitCode = 1;
}
