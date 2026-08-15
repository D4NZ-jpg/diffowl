import { createHash } from "node:crypto";

import {
  canonicalJson,
  canonicalJsonHash,
  isJsonObject,
  type JsonValue,
  requireJsonVersion,
} from "./canonical-json.js";

export const FINDING_FINGERPRINT_VERSION = 1;
export const FINDING_FINGERPRINT_ALGORITHM = "diffowl-finding-v1";

export function findingShortIdentityFromFingerprint(fingerprint: string): string {
  return `F-${createHash("sha256").update(fingerprint).digest("hex").slice(0, 8)}`;
}

export interface EvidenceAnchorInput {
  kind: string;
  path?: string | undefined;
  stableId?: string | undefined;
  excerpt?: string | undefined;
  policyRule?: string | undefined;
  capability?: string | undefined;
}

export interface LocationContextInput {
  path: string;
  symbol?: string | undefined;
  api?: string | undefined;
  configKey?: string | undefined;
  behavior?: string | undefined;
  surroundingText?: string | undefined;
}

export interface FindingFingerprintInput {
  claimKind: string;
  summary: string;
  affectedArea: string;
  evidenceAnchors: EvidenceAnchorInput[];
  policyOrCapability: string;
  location: LocationContextInput;
}

export interface FindingFingerprint {
  version: typeof FINDING_FINGERPRINT_VERSION;
  algorithm: typeof FINDING_FINGERPRINT_ALGORITHM;
  value: string;
  components: JsonValue;
}

function pathLineCitationPattern(): RegExp {
  return /\b((?:(?:[\p{L}\p{N}_.-]+\/)+[\p{L}\p{N}_./-]+\.[\p{L}\p{N}]+)|(?:[\p{L}\p{N}_.-]+\.[\p{L}\p{N}]+)):(\d+)(?:[-:](\d+))?\b/giu;
}

function isNetworkAuthority(value: string): boolean {
  if (/^(?:\d{1,3}\.){3}\d{1,3}$/u.test(value)) return true;
  const labels = value.split(".");
  return (
    labels.length > 2 || /^(?:com|net|org|io|dev|app|local|internal)$/iu.test(labels.at(-1) ?? "")
  );
}

function stripPathLineCitation(value: string): string {
  return value.replace(pathLineCitationPattern(), (citation, path: string) =>
    path.includes("/") || !isNetworkAuthority(path) ? path : citation,
  );
}

function normalizeText(value: string): string {
  return stripPathLineCitation(value)
    .normalize("NFKC")
    .toLowerCase()
    .replace(
      /https:\/\/github\.com\/\S+\/pull\/\d+(?:#discussion_r\d+|#pullrequestreview-\d+)?/giu,
      "github-review",
    )
    .replace(
      /\b(?:discussion_r|pullrequestreviewcomment-|pullrequestreview-)\d+\b/giu,
      "github-review",
    )
    .replace(/https:\/\/github\.com\/\S+#L\d+(?:-L\d+)?/giu, "github-line-anchor")
    .replace(/#L\d+(?:-L\d+)?/giu, "")
    .replace(/\b(?:line|lines)\s+\d+(?:\s*[-–]\s*\d+)?\b/giu, "line")
    .replace(/\bL\d+(?:-L?\d+)?\b/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function normalizePath(value: string): string {
  return stripPathLineCitation(value)
    .replaceAll("\\", "/")
    .replace(/^\.\//u, "")
    .replace(/\/+/gu, "/");
}

function normalizeExcerpt(value: string): string {
  return normalizeText(
    value
      .replace(/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@.*$/gmu, "")
      .replace(/^[+-]{3}\s+\S+$/gmu, "")
      .replace(/^\d+\s*[|:]\s*/gmu, ""),
  );
}

function normalizedAnchor(anchor: EvidenceAnchorInput): JsonValue {
  const result: Record<string, JsonValue> = { kind: normalizeText(anchor.kind) };
  if (anchor.path !== undefined) result.path = normalizePath(anchor.path);
  if (anchor.stableId !== undefined) result.stableId = normalizeText(anchor.stableId);
  if (anchor.excerpt !== undefined) result.excerpt = normalizeExcerpt(anchor.excerpt);
  if (anchor.policyRule !== undefined) result.policyRule = normalizeText(anchor.policyRule);
  if (anchor.capability !== undefined) result.capability = normalizeText(anchor.capability);
  return result;
}

function normalizedLocation(location: LocationContextInput): JsonValue {
  const result: Record<string, JsonValue> = { path: normalizePath(location.path) };
  if (location.symbol !== undefined) result.symbol = normalizeText(location.symbol);
  if (location.api !== undefined) result.api = normalizeText(location.api);
  if (location.configKey !== undefined) result.configKey = normalizeText(location.configKey);
  if (location.behavior !== undefined) result.behavior = normalizeText(location.behavior);
  if (location.surroundingText !== undefined) {
    result.surroundingText = normalizeExcerpt(location.surroundingText);
  }
  return result;
}

function fingerprintComponents(input: FindingFingerprintInput): JsonValue {
  const anchors = [
    ...new Map(
      input.evidenceAnchors.map((anchor) => {
        const normalized = normalizedAnchor(anchor);
        return [canonicalJson(normalized), normalized] as const;
      }),
    ).entries(),
  ]
    // oxlint-disable-next-line no-array-sort
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, anchor]) => anchor);
  return {
    claimKind: normalizeText(input.claimKind),
    summary: normalizeText(input.summary),
    affectedArea: normalizeText(input.affectedArea),
    evidenceAnchors: anchors,
    location: normalizedLocation(input.location),
    policyOrCapability: normalizeText(input.policyOrCapability),
  };
}

export function createFindingFingerprint(input: FindingFingerprintInput): FindingFingerprint {
  const components = fingerprintComponents(input);
  return {
    version: FINDING_FINGERPRINT_VERSION,
    algorithm: FINDING_FINGERPRINT_ALGORITHM,
    value: canonicalJsonHash({ algorithm: FINDING_FINGERPRINT_ALGORITHM, components }),
    components,
  };
}

function validComponents(value: unknown): value is JsonValue {
  if (!isJsonObject(value)) return false;
  const strings = ["claimKind", "summary", "affectedArea", "policyOrCapability"];
  if (!strings.every((key) => typeof value[key] === "string")) return false;
  if (!Array.isArray(value.evidenceAnchors)) return false;
  if (!value.evidenceAnchors.every((anchor) => isJsonObject(anchor))) return false;
  return isJsonObject(value.location) && typeof value.location.path === "string";
}

export function parseFindingFingerprint(value: unknown): FindingFingerprint {
  requireJsonVersion(value, FINDING_FINGERPRINT_VERSION, "Finding fingerprint");
  if (
    value.algorithm !== FINDING_FINGERPRINT_ALGORITHM ||
    typeof value.value !== "string" ||
    !/^sha256:[\da-f]{64}$/u.test(value.value) ||
    !validComponents(value.components)
  ) {
    throw new Error("Finding fingerprint is not supported.");
  }
  const expected = canonicalJsonHash({
    algorithm: FINDING_FINGERPRINT_ALGORITHM,
    components: value.components,
  });
  if (value.value !== expected)
    throw new Error("Finding fingerprint hash does not match components.");
  return value as unknown as FindingFingerprint;
}
