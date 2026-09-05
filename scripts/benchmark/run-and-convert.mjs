#!/usr/bin/env node
// Run `diffowl review` on every inputs/<slug>.json and write results/benchmark_data.json
// in the shape withmartian/code-review-benchmark step 2 reads.
//
// Usage: node scripts/benchmark/run-and-convert.mjs [--golden <path-to-crb/offline/golden_comments>]
// Env:   DIFFOWL_BIN (default: node dist/cli.js), DIFFOWL_POLICY (default: scripts/benchmark/policy.json),
//        DIFFOWL_CREDENTIALS (default: env). With env, set ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL
//        (see scripts/benchmark/env.example).
//        DIFFOWL_RUN_TAG (default: ""): suffix for reports/results dirs so runs can be compared.
// The review runs with cwd = checkouts/<slug> when that directory exists (verifier reads files
// and runs validation commands relative to cwd). Per-repo policy: policies/<repo>.json overrides
// policy.json when present (repo = second path segment of the PR URL, e.g. "grafana").
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const inputsDir = join(here, "inputs");
const tag = process.env.DIFFOWL_RUN_TAG ?? "";
const reportsDir = join(here, `reports${tag}`);
const resultsDir = join(here, `results${tag}`);
const checkoutsDir = join(here, "checkouts");
const policiesDir = join(here, "policies");
mkdirSync(reportsDir, { recursive: true });
mkdirSync(resultsDir, { recursive: true });

const args = process.argv.slice(2);
const goldenDir = args.includes("--golden") ? args[args.indexOf("--golden") + 1] : undefined;
const policy = process.env.DIFFOWL_POLICY ?? join(here, "policy.json");
const bin = (process.env.DIFFOWL_BIN ?? `node ${resolve(root, "dist/cli.js")}`).split(" ");
const credentials = process.env.DIFFOWL_CREDENTIALS ?? "env";

const golden = new Map();
if (goldenDir !== undefined) {
  for (const file of readdirSync(goldenDir).filter((f) => f.endsWith(".json"))) {
    for (const entry of JSON.parse(readFileSync(join(goldenDir, file), "utf8"))) {
      golden.set(entry.url, { ...entry, source_file: file });
    }
  }
}

const output = existsSync(join(resultsDir, "benchmark_data.json"))
  ? JSON.parse(readFileSync(join(resultsDir, "benchmark_data.json"), "utf8"))
  : {};

const concurrency = Math.max(1, Number(process.env.DIFFOWL_CONCURRENCY ?? "1"));

function reviewOnce(file) {
  const input = JSON.parse(readFileSync(join(inputsDir, file), "utf8"));
  const reportPath = join(reportsDir, file);
  const slug = file.replace(/\.json$/, "");
  const checkout = join(checkoutsDir, slug);
  const cwd = existsSync(join(checkout, ".git")) ? checkout : root;
  const repoPolicy = join(policiesDir, `${input.repository.split("/")[1]}.json`);
  const policyPath = existsSync(repoPolicy) ? repoPolicy : policy;
  if (existsSync(reportPath)) {
    console.log(`skip ${file} (report exists)`);
    return Promise.resolve({ file, input, report: JSON.parse(readFileSync(reportPath, "utf8")) });
  }
  console.log(
    `run  ${file}  (cwd=${cwd === root ? "none" : "checkout"}, policy=${policyPath.split("/").slice(-2).join("/")})`,
  );
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    execFile(
      bin[0],
      [
        ...bin.slice(1),
        "review",
        "--input",
        join(inputsDir, file),
        "--policy",
        policyPath,
        "--credentials",
        credentials,
        ...(cwd === root ? [] : ["--repository", cwd]),
      ],
      { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (stderr) process.stderr.write(stderr.replace(/^/gm, `[${slug}] `));
        if (error && !stdout) {
          reject(new Error(`${file}: ${error.message}`));
          return;
        }
        const report = JSON.parse(stdout);
        report.elapsedSeconds = (Date.now() - started) / 1000;
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
        console.log(
          `done ${file}  ${report.diagnostics?.outcomeType} material=${report.findings?.length ?? 0} advisory=${report.advisorySuggestions?.length ?? 0} ${Math.round(report.elapsedSeconds)}s`,
        );
        resolvePromise({ file, input, report });
      },
    );
  });
}

const queue = readdirSync(inputsDir).filter((f) => f.endsWith(".json"));
const completed = [];
const failures = [];
async function worker() {
  // Sequential by design: each worker is one lane of a bounded pool.
  while (queue.length > 0) {
    const file = queue.shift();
    try {
      // oxlint-disable-next-line no-await-in-loop
      completed.push(await reviewOnce(file));
    } catch (error) {
      failures.push(String(error.message));
      console.log(`FAIL ${file}: ${String(error.message).split("\n")[0]}`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

for (const { input, report } of completed) {
  const comments = [];
  for (const finding of report.findings ?? []) {
    comments.push({
      path: finding.location?.path ?? "",
      line: finding.location?.line ?? finding.location?.startLine ?? null,
      body: `${finding.summary}\n\nImpact: ${finding.impact}`,
      created_at: new Date().toISOString(),
      kind: "material",
    });
  }
  for (const suggestion of report.advisorySuggestions ?? []) {
    comments.push({
      path: suggestion.location?.path ?? "",
      line: suggestion.location?.line ?? suggestion.location?.startLine ?? null,
      body: `${suggestion.summary}\n\n${suggestion.rationale}`,
      created_at: new Date().toISOString(),
      kind: "advisory",
    });
  }

  const goldenEntry = golden.get(input.goldenUrl);
  const key = input.goldenUrl;
  output[key] ??= {
    pr_title: goldenEntry?.pr_title ?? input.title,
    original_url: input.goldenUrl,
    source_repo: input.repository.split("/")[1],
    golden_comments: goldenEntry?.comments ?? [],
    golden_source_file: goldenEntry?.source_file ?? "",
    az_comment: goldenEntry?.az_comment ?? "",
    reviews: [],
  };
  output[key].reviews = output[key].reviews.filter((r) => r.tool !== "diffowl");
  output[key].reviews.push({
    tool: "diffowl",
    repo_name: input.repository,
    pr_url: input.goldenUrl,
    review_comments: comments,
    outcome_type: report.diagnostics?.outcomeType,
    elapsed_seconds: report.elapsedSeconds,
  });
  console.log(
    `     ${report.diagnostics?.outcomeType} material=${report.findings?.length ?? 0} advisory=${report.advisorySuggestions?.length ?? 0}`,
  );
}

writeFileSync(join(resultsDir, "benchmark_data.json"), JSON.stringify(output, null, 2));
if (failures.length > 0) {
  console.log(`\n${failures.length} review(s) failed; rerun to retry them.`);
  process.exitCode = 1;
}
console.log(
  `\nwrote ${join(resultsDir, "benchmark_data.json")} (${Object.keys(output).length} PRs)`,
);
console.log(
  "Copy it to <crb>/offline/results/benchmark_data.json, then run steps 2, 2.5, 3, 4 with --tool diffowl.",
);
