import { createHash } from "node:crypto";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

function ordered(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((item) => ordered(item));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      // Canonical JSON uses locale-independent UTF-16 code-unit ordering.
      // oxlint-disable-next-line no-array-sort
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, item]) => [key, ordered(item)]),
  );
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(ordered(value));
}

export function canonicalJsonHash(value: JsonValue): string {
  const digest = createHash("sha256").update(canonicalJson(value)).digest("hex");
  return `sha256:${digest}`;
}

export function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireJsonVersion(
  value: unknown,
  version: number,
  noun: string,
): asserts value is Record<string, unknown> {
  if (!isJsonObject(value) || value.version !== version) {
    throw new Error(`${noun} version must be ${version}.`);
  }
}
