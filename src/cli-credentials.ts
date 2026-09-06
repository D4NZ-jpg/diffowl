import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  createPostgresCredentialStore,
  postgresCredentialStoreSql,
} from "@runcell/postgres-credentials";
import pg from "pg";

import { CREDENTIAL_STORE_DEFAULT_KEY } from "./action-credentials.js";
import type { DiffowlAuthBlob, DiffowlStoredCredential } from "./review-orchestration.js";

export interface CredentialsCliIo {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  stdout(text: string): void;
  stderr(text: string): void;
  env: NodeJS.ProcessEnv;
  /** Test seam; defaults to a Postgres-backed store for the given URL. */
  openStore?(url: string, secret: string | undefined): { store: StoreLike; close(): Promise<void> };
}

interface StoreLike {
  withLock<T>(
    key: string,
    fn: (current: DiffowlAuthBlob | undefined) => Promise<{ result: T; next?: DiffowlAuthBlob }>,
  ): Promise<T>;
}

interface PushOptions {
  providers: string[];
  key: string;
  agentDir: string;
}

const usage = [
  "Usage:",
  "  diffowl credentials sql",
  "      Print the CREATE TABLE statement for the shared credential store.",
  "  diffowl credentials push --provider <id> [--provider <id>] [--key <row-key>] [--agent-dir <path>]",
  "      Copy the named provider entries from the local agent auth file into the",
  "      shared store row. Reads DIFFOWL_CREDENTIAL_STORE_URL and, optionally,",
  "      DIFFOWL_CREDENTIAL_STORE_SECRET from the environment. Only the named",
  "      providers are sent; nothing is printed.",
  "  diffowl credentials status [--key <row-key>]",
  "      List provider ids and token expiry in the shared store row, without secrets.",
].join("\n");

function parsePush(args: readonly string[]): PushOptions | string {
  const options: PushOptions = {
    providers: [],
    key: CREDENTIAL_STORE_DEFAULT_KEY,
    agentDir: join(homedir(), ".pi", "agent"),
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--"))
      return `${arg} requires a value.\n\n${usage}`;
    if (arg === "--provider") options.providers.push(value);
    else if (arg === "--key") options.key = value;
    else if (arg === "--agent-dir") options.agentDir = value;
    else return `Unknown argument: ${arg}\n\n${usage}`;
    index += 1;
  }
  return options.providers.length === 0 ? `--provider is required.\n\n${usage}` : options;
}

function isStoredCredential(value: unknown): value is DiffowlStoredCredential {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (record.type === "api_key") return true;
  return (
    record.type === "oauth" &&
    typeof record.access === "string" &&
    typeof record.refresh === "string" &&
    typeof record.expires === "number"
  );
}

function defaultOpenStore(
  url: string,
  secret: string | undefined,
): { store: StoreLike; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  const store = createPostgresCredentialStore({
    pool,
    ensureTable: false,
    ...(secret === undefined ? {} : { encryptionKey: secret }),
  });
  return { store, close: () => pool.end() };
}

function storeFrom(io: CredentialsCliIo): { store: StoreLike; close(): Promise<void> } | string {
  const url = io.env.DIFFOWL_CREDENTIAL_STORE_URL?.trim();
  if (url === undefined || url === "") return "DIFFOWL_CREDENTIAL_STORE_URL is not set.";
  const secret = io.env.DIFFOWL_CREDENTIAL_STORE_SECRET?.trim();
  return (io.openStore ?? defaultOpenStore)(url, secret === "" ? undefined : secret);
}

async function push(args: readonly string[], io: CredentialsCliIo): Promise<number> {
  const options = parsePush(args);
  if (typeof options === "string") {
    io.stderr(`${options}\n`);
    return 2;
  }
  const local: unknown = JSON.parse(await io.readFile(join(options.agentDir, "auth.json"), "utf8"));
  if (typeof local !== "object" || local === null) {
    io.stderr("The local auth file is not a JSON object.\n");
    return 1;
  }
  const selected: DiffowlAuthBlob = {};
  for (const provider of options.providers) {
    const entry = (local as Record<string, unknown>)[provider];
    if (!isStoredCredential(entry)) {
      io.stderr(`Provider "${provider}" is not present in the local auth file or is malformed.\n`);
      return 1;
    }
    selected[provider] = entry;
  }
  const opened = storeFrom(io);
  if (typeof opened === "string") {
    io.stderr(`${opened}\n`);
    return 2;
  }
  try {
    await opened.store.withLock(options.key, async (current) => ({
      result: undefined,
      next: { ...current, ...selected },
    }));
    io.stdout(
      `Stored ${options.providers.join(", ")} in row "${options.key}". Existing entries for other providers were kept.\n`,
    );
    return 0;
  } finally {
    await opened.close();
  }
}

async function status(args: readonly string[], io: CredentialsCliIo): Promise<number> {
  const key = args[0] === "--key" && args[1] !== undefined ? args[1] : CREDENTIAL_STORE_DEFAULT_KEY;
  const opened = storeFrom(io);
  if (typeof opened === "string") {
    io.stderr(`${opened}\n`);
    return 2;
  }
  try {
    const summary = await opened.store.withLock(key, async (current) => ({
      result: Object.entries(current ?? {}).map(([provider, entry]) =>
        entry.type === "oauth"
          ? `${provider}: oauth, expires ${new Date(entry.expires).toISOString()}`
          : `${provider}: api_key`,
      ),
    }));
    io.stdout(
      summary.length === 0 ? `Row "${key}" is empty or absent.\n` : `${summary.join("\n")}\n`,
    );
    return 0;
  } finally {
    await opened.close();
  }
}

export async function runCredentialsCli(
  args: readonly string[],
  io: CredentialsCliIo = {
    readFile,
    stdout: (t) => process.stdout.write(t),
    stderr: (t) => process.stderr.write(t),
    env: process.env,
  },
): Promise<number> {
  const [command, ...rest] = args;
  if (command === "sql") {
    io.stdout(`${postgresCredentialStoreSql()}\n`);
    return 0;
  }
  if (command === "push") return push(rest, io);
  if (command === "status") return status(rest, io);
  io.stderr(`${usage}\n`);
  return 2;
}
