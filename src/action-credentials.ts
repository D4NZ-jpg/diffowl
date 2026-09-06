import { createPostgresCredentialStore } from "@runcell/postgres-credentials";
import pg from "pg";

import type { DiffowlCredentials } from "./review-orchestration.js";

/**
 * Environment variables that select the shared credential store for the
 * `default` profile. All three are consumed and deleted from the process
 * environment by {@link resolveActionCredentials} before any role or validation
 * command can run, the same way `GITHUB_TOKEN` is.
 */
export const CREDENTIAL_STORE_URL = "DIFFOWL_CREDENTIAL_STORE_URL";
export const CREDENTIAL_STORE_KEY = "DIFFOWL_CREDENTIAL_STORE_KEY";
export const CREDENTIAL_STORE_SECRET = "DIFFOWL_CREDENTIAL_STORE_SECRET";
export const CREDENTIAL_STORE_DEFAULT_KEY = "diffowl-default";

export interface ActionCredentialResolution {
  profiles: Readonly<Record<string, DiffowlCredentials>>;
  /** Releases the database pool. A no-op for the env profile. */
  close(): Promise<void>;
  source: "env" | "postgres";
}

function take(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  delete env[name];
  return value === "" ? undefined : value;
}

/**
 * Resolve the `default` credential profile for an Action run.
 *
 * With `DIFFOWL_CREDENTIAL_STORE_URL` set, the profile is a shared store
 * backed by that Postgres (Supabase, Neon, RDS, or any pooler in transaction
 * mode). The row named by `DIFFOWL_CREDENTIAL_STORE_KEY` holds the provider
 * auth blob, including OAuth refresh tokens, which runcell refreshes under the
 * row lock so concurrent runners never clobber each other. The table must
 * already exist: the runner role is not given DDL, see `diffowl credentials`.
 *
 * Without the URL, provider keys are read from `*_API_KEY` / `*_BASE_URL`
 * environment variables as before.
 */
export function resolveActionCredentials(env: NodeJS.ProcessEnv): ActionCredentialResolution {
  const url = take(env, CREDENTIAL_STORE_URL);
  const key = take(env, CREDENTIAL_STORE_KEY) ?? CREDENTIAL_STORE_DEFAULT_KEY;
  const secret = take(env, CREDENTIAL_STORE_SECRET);
  if (url === undefined) {
    return { profiles: { default: { type: "env" } }, close: async () => undefined, source: "env" };
  }
  const pool = new pg.Pool({ connectionString: url, max: 2 });
  const store = createPostgresCredentialStore({
    pool,
    ensureTable: false,
    ...(secret === undefined ? {} : { encryptionKey: secret }),
  });
  return {
    profiles: { default: { type: "shared", key, store } },
    close: () => pool.end(),
    source: "postgres",
  };
}
