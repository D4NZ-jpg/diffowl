#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { createHostVerificationAdapter } from "./host-verification.js";
import {
  type DiffowlCredentials,
  type FindingLedger,
  type PullRequestInput,
  type ReviewOutcome,
  type ReviewRunRecord,
  type RoleExecutionRequest,
  type RoleExecutionResult,
  type VerificationAdapter,
  FileSystemReviewPersistenceStore,
  runReview,
} from "./review-engine.js";
import { classifyTrust } from "./trust.js";

export interface CliIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  credentialProfiles?: Readonly<Record<string, DiffowlCredentials>>;
  executeRole?(request: RoleExecutionRequest): Promise<RoleExecutionResult>;
  verificationAdapter?: VerificationAdapter;
}

const processIo: CliIo = {
  readFile,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

type CliPullRequestInput = Omit<PullRequestInput, "policy" | "trust">;
type CliMode = "dry-run" | "publish";

interface CliReport {
  adapter: "local_cli";
  mode: CliMode;
  ciTrusted: false;
  trust: ReviewOutcome["trust"];
  publishing: { requested: boolean; status: "denied_local_invocation"; note: string };
  outcome: ReviewOutcome;
  findings: unknown[];
  advisorySuggestions: unknown[];
  verification: unknown;
  runRecord?: ReviewRunRecord | undefined;
  ledger?: FindingLedger | undefined;
  diagnostics: {
    outcomeType: ReviewOutcome["type"];
    reason?: string | undefined;
    timeoutSeconds?: number | undefined;
    validationAttemptCount: number;
    providerArtifactCount: number;
    ledgerEntryCount?: number | undefined;
  };
}

function isPullRequestInput(value: unknown): value is CliPullRequestInput {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const input = value as Record<string, unknown>;
  return (
    typeof input.repository === "string" &&
    typeof input.number === "number" &&
    Number.isInteger(input.number) &&
    typeof input.baseSha === "string" &&
    typeof input.headSha === "string" &&
    typeof input.diff === "string"
  );
}

interface CliOptions {
  input: string;
  policy: string;
  stateDirectory?: string;
  mode: CliMode;
}

function usage(): string {
  return [
    "Usage: diffowl review --input <pull-request.json> --policy <local-policy.json> [options]",
    "",
    "Options:",
    "  --state-directory <path>  Persist and inspect local run records and Finding ledger state.",
    "  --dry-run                 Run locally without publishing. This is the default.",
    "  --publish                 Request publishing mode; local trust still denies GitHub publication.",
  ].join("\n");
}

function optionValue(args: readonly string[], index: number): string | undefined {
  const value = args[index + 1];
  return value === undefined || value.startsWith("--") ? undefined : value;
}

function assignPathOption(options: Partial<CliOptions>, arg: string, value: string): void {
  if (arg === "--input") options.input = value;
  else if (arg === "--policy") options.policy = value;
  else options.stateDirectory = value;
}

function applyOption(
  options: Partial<CliOptions>,
  args: readonly string[],
  index: number,
): number | string {
  const arg = args[index];
  if (arg === "--dry-run") options.mode = "dry-run";
  else if (arg === "--publish") options.mode = "publish";
  else if (arg === "--input" || arg === "--policy" || arg === "--state-directory") {
    const value = optionValue(args, index);
    if (value === undefined) return `${arg} requires a value.\n\n${usage()}`;
    assignPathOption(options, arg, value);
    return index + 1;
  } else return `Unknown argument: ${arg}\n\n${usage()}`;
  return index;
}

function optionsFrom(args: readonly string[]): CliOptions | string {
  if (args[0] !== "review") return usage();
  const options: Partial<CliOptions> = { mode: "dry-run" };
  for (let index = 1; index < args.length; index += 1) {
    const nextIndex = applyOption(options, args, index);
    if (typeof nextIndex === "string") return nextIndex;
    index = nextIndex;
  }
  return options.input === undefined || options.policy === undefined
    ? usage()
    : (options as CliOptions);
}

function findings(outcome: ReviewOutcome): unknown[] {
  return "materialFindings" in outcome && outcome.materialFindings !== undefined
    ? outcome.materialFindings
    : [];
}

function advisorySuggestions(outcome: ReviewOutcome): unknown[] {
  return "advisorySuggestions" in outcome && outcome.advisorySuggestions !== undefined
    ? outcome.advisorySuggestions
    : [];
}

function verification(outcome: ReviewOutcome): unknown {
  return "verification" in outcome ? outcome.verification : undefined;
}

function executionArtifactCount(outcome: ReviewOutcome): number {
  return "executionArtifacts" in outcome && outcome.executionArtifacts !== undefined
    ? outcome.executionArtifacts.length
    : 0;
}

async function persistedState(
  options: CliOptions,
  input: CliPullRequestInput,
  outcome: ReviewOutcome,
): Promise<{ ledger?: FindingLedger | undefined; runRecord?: ReviewRunRecord | undefined }> {
  if (options.stateDirectory === undefined) return {};
  const store = new FileSystemReviewPersistenceStore(options.stateDirectory);
  return store.withTransaction(
    { repository: input.repository, pullRequestNumber: input.number },
    async (transaction) => ({
      ledger: await transaction.loadLedger(),
      runRecord:
        outcome.run === undefined ? undefined : await transaction.loadRunRecord(outcome.run.runId),
    }),
  );
}

function reportFrom(
  mode: CliMode,
  outcome: ReviewOutcome,
  state: { ledger?: FindingLedger | undefined; runRecord?: ReviewRunRecord | undefined },
): CliReport {
  const attempts =
    "verification" in outcome && outcome.verification !== undefined
      ? outcome.verification.validationAttempts.length
      : 0;
  return {
    adapter: "local_cli",
    mode,
    ciTrusted: false,
    trust: outcome.trust,
    publishing: {
      requested: mode === "publish",
      status: "denied_local_invocation",
      note: "Local CLI output is reproduction data only; it is not GitHub Action trust evidence.",
    },
    outcome,
    findings: findings(outcome),
    advisorySuggestions: advisorySuggestions(outcome),
    verification: verification(outcome),
    ...state,
    diagnostics: {
      outcomeType: outcome.type,
      ...("reason" in outcome ? { reason: outcome.reason } : {}),
      ...(outcome.type === "timeout" ? { timeoutSeconds: outcome.timeoutSeconds } : {}),
      validationAttemptCount: attempts,
      providerArtifactCount: executionArtifactCount(outcome),
      ...(state.ledger === undefined ? {} : { ledgerEntryCount: state.ledger.entries.length }),
    },
  };
}

export async function runCli(args: readonly string[], io: CliIo = processIo): Promise<number> {
  const options = optionsFrom(args);
  if (typeof options === "string") {
    io.stderr(`${options}\n`);
    return 2;
  }

  try {
    const input: unknown = JSON.parse(await io.readFile(options.input, "utf8"));
    if (!isPullRequestInput(input)) {
      io.stderr("Pull-request input does not match the required schema.\n");
      return 2;
    }

    const outcome = await runReview(
      {
        ...input,
        trust: classifyTrust({ type: "local_cli" }),
        policy: {
          source: { type: "local_invocation", path: options.policy },
          contents: await io.readFile(options.policy, "utf8"),
        },
      },
      {
        credentialProfiles: io.credentialProfiles ?? { default: "local" },
        executeRole: io.executeRole,
        verificationAdapter: io.verificationAdapter ?? createHostVerificationAdapter(),
        persistence:
          options.stateDirectory === undefined
            ? undefined
            : new FileSystemReviewPersistenceStore(options.stateDirectory),
      },
    );
    io.stdout(
      `${JSON.stringify(reportFrom(options.mode, outcome, await persistedState(options, input, outcome)))}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`Review failed: ${message}\n`);
    return 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
