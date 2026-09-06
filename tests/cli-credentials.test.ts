import { describe, expect, it } from "vitest";

import { type CredentialsCliIo, runCredentialsCli } from "../src/cli-credentials.js";
import type { DiffowlAuthBlob } from "../src/review-orchestration.js";

const localAuth = {
  anthropic: { type: "oauth", access: "a-1", refresh: "r-1", expires: 1_800_000_000_000 },
  "openai-codex": { type: "oauth", access: "o-1", refresh: "r-2", expires: 1_800_000_000_000 },
  broken: { type: "oauth", access: "x" },
};

function fakeIo(
  env: NodeJS.ProcessEnv,
  rows: Map<string, DiffowlAuthBlob>,
): { io: CredentialsCliIo; out: string[]; err: string[]; closed: number[] } {
  const out: string[] = [];
  const err: string[] = [];
  const closed: number[] = [];
  return {
    out,
    err,
    closed,
    io: {
      env,
      readFile: async () => JSON.stringify(localAuth),
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      openStore: () => ({
        store: {
          withLock: async (key, fn) => {
            const { result, next } = await fn(rows.get(key));
            if (next !== undefined) rows.set(key, next);
            return result;
          },
        },
        close: async () => {
          closed.push(1);
        },
      }),
    },
  };
}

describe("diffowl credentials", () => {
  it("prints the migration SQL without needing a store", async () => {
    const { io, out } = fakeIo({}, new Map());
    expect(await runCredentialsCli(["sql"], io)).toBe(0);
    expect(out.join("")).toContain("CREATE TABLE IF NOT EXISTS");
  });

  it("pushes only the named providers and merges into the existing row", async () => {
    const rows = new Map<string, DiffowlAuthBlob>([
      ["diffowl-default", { zcode: { type: "api_key", key: "keep-me" } }],
    ]);
    const { io, out, closed } = fakeIo({ DIFFOWL_CREDENTIAL_STORE_URL: "postgres://x" }, rows);
    expect(await runCredentialsCli(["push", "--provider", "anthropic"], io)).toBe(0);
    expect(rows.get("diffowl-default")).toEqual({
      zcode: { type: "api_key", key: "keep-me" },
      anthropic: localAuth.anthropic,
    });
    expect(out.join("")).not.toContain("a-1");
    expect(out.join("")).not.toContain("r-1");
    expect(closed).toHaveLength(1);
  });

  it("refuses a malformed or missing provider entry before touching the store", async () => {
    const rows = new Map<string, DiffowlAuthBlob>();
    const { io, err } = fakeIo({ DIFFOWL_CREDENTIAL_STORE_URL: "postgres://x" }, rows);
    expect(await runCredentialsCli(["push", "--provider", "broken"], io)).toBe(1);
    expect(await runCredentialsCli(["push", "--provider", "nope"], io)).toBe(1);
    expect(rows.size).toBe(0);
    expect(err.join("")).toContain('"broken"');
  });

  it("requires the store URL and a provider", async () => {
    const { io, err } = fakeIo({}, new Map());
    expect(await runCredentialsCli(["push", "--provider", "anthropic"], io)).toBe(2);
    expect(err.join("")).toContain("DIFFOWL_CREDENTIAL_STORE_URL");
    expect(await runCredentialsCli(["push"], io)).toBe(2);
    expect(await runCredentialsCli(["bogus"], io)).toBe(2);
  });

  it("reports providers and expiry without printing token material", async () => {
    const rows = new Map<string, DiffowlAuthBlob>([
      ["team", { anthropic: localAuth.anthropic as never, zcode: { type: "api_key", key: "s" } }],
    ]);
    const { io, out } = fakeIo({ DIFFOWL_CREDENTIAL_STORE_URL: "postgres://x" }, rows);
    expect(await runCredentialsCli(["status", "--key", "team"], io)).toBe(0);
    const text = out.join("");
    expect(text).toContain("anthropic: oauth, expires 2027-");
    expect(text).toContain("zcode: api_key");
    expect(text).not.toContain("a-1");
    expect(text).not.toContain("r-1");
  });
});
