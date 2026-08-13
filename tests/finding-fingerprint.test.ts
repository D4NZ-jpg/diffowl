/* oxlint-disable max-lines-per-function */
import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical-json.js";
import {
  createFindingFingerprint,
  parseFindingFingerprint,
  type FindingFingerprintInput,
} from "../src/finding-fingerprint.js";

function fingerprintInput(
  overrides: Partial<FindingFingerprintInput> = {},
): FindingFingerprintInput {
  return {
    claimKind: "Validation bypass",
    summary: "Checkout accepts expired tokens at line 41",
    affectedArea: "src/auth.ts validateToken",
    policyOrCapability: "policy: authentication",
    evidenceAnchors: [
      {
        kind: "repository_file",
        path: "./src/auth.ts",
        stableId: "validateToken",
        excerpt: "@@ -40,7 +55,7 @@\n41| if (token.expired) return true;",
      },
    ],
    location: {
      path: "src/auth.ts",
      symbol: "validateToken",
      surroundingText: "41: if (token.expired) return true;",
    },
    ...overrides,
  };
}

describe("createFindingFingerprint", () => {
  it("is stable across line and hunk movement", () => {
    const moved = fingerprintInput({
      summary: "Checkout accepts expired tokens at line 108",
      evidenceAnchors: [
        {
          kind: "repository_file",
          path: "src/auth.ts",
          stableId: "validateToken",
          excerpt: "@@ -104,7 +108,7 @@\n108| if (token.expired) return true;",
        },
      ],
      location: {
        path: "./src/auth.ts",
        symbol: "validateToken",
        surroundingText: "108: if (token.expired) return true;",
      },
    });

    expect(createFindingFingerprint(fingerprintInput()).value).toBe(
      createFindingFingerprint(moved).value,
    );
  });

  it("ignores path line citations and GitHub review thread identifiers", () => {
    const first = fingerprintInput({
      summary: "Failure at src/auth.ts:41 lines 41-43 discussion_r123",
      evidenceAnchors: [
        {
          kind: "repository_file",
          path: "src/auth.ts:41",
          excerpt: "https://github.com/acme/app/pull/7#discussion_r123 failure",
        },
      ],
    });
    const moved = fingerprintInput({
      summary: "Failure at src/auth.ts:108 lines 108-110 discussion_r999",
      evidenceAnchors: [
        {
          kind: "repository_file",
          path: "src/auth.ts:108",
          excerpt: "https://github.com/acme/app/pull/7#discussion_r999 failure",
        },
      ],
    });
    expect(createFindingFingerprint(first).value).toBe(createFindingFingerprint(moved).value);
  });

  it("keeps host ports and config numbers distinct while stripping file line citations", () => {
    const port3000 = fingerprintInput({ summary: "Proxy forwards to localhost:3000" });
    const port4000 = fingerprintInput({ summary: "Proxy forwards to localhost:4000" });
    const dottedHost3000 = fingerprintInput({ summary: "Proxy forwards to api.example.com:3000" });
    const dottedHost4000 = fingerprintInput({ summary: "Proxy forwards to api.example.com:4000" });
    const ipv4Port3000 = fingerprintInput({ summary: "Proxy forwards to 192.0.2.1:3000" });
    const ipv4Port4000 = fingerprintInput({ summary: "Proxy forwards to 192.0.2.1:4000" });
    const fileLine41 = fingerprintInput({ summary: "Failure in src/auth.ts:41" });
    const fileLine108 = fingerprintInput({ summary: "Failure in src/auth.ts:108" });
    const fileRange = fingerprintInput({ summary: "Failure in src/auth.ts:108-110" });

    for (const [left, right] of [
      [port3000, port4000],
      [dottedHost3000, dottedHost4000],
      [ipv4Port3000, ipv4Port4000],
    ]) {
      expect(createFindingFingerprint(left!).value).not.toBe(
        createFindingFingerprint(right!).value,
      );
    }
    expect(createFindingFingerprint(fileLine41).value).toBe(
      createFindingFingerprint(fileLine108).value,
    );
    expect(createFindingFingerprint(fileLine41).value).toBe(
      createFindingFingerprint(fileRange).value,
    );
  });

  it("normalizes, deduplicates, and sorts evidence anchors", () => {
    const anchor = fingerprintInput().evidenceAnchors[0]!;
    const other = { kind: "policy", policyRule: "AUTH-1" };
    const reordered = fingerprintInput({ evidenceAnchors: [other, anchor, anchor] });
    const canonical = fingerprintInput({ evidenceAnchors: [anchor, other] });

    expect(createFindingFingerprint(reordered).value).toBe(
      createFindingFingerprint(canonical).value,
    );
  });

  it("uses locale-independent canonical key ordering", () => {
    expect(canonicalJson({ ä: 1, z: 2, A: 3 })).toBe('{"A":3,"z":2,"ä":1}');
  });

  it("changes when identity components change", () => {
    const baseline = createFindingFingerprint(fingerprintInput()).value;
    const otherPolicy = createFindingFingerprint(
      fingerprintInput({ policyOrCapability: "policy: billing correctness" }),
    ).value;
    const otherArea = createFindingFingerprint(
      fingerprintInput({ affectedArea: "src/billing.ts" }),
    ).value;

    expect(otherPolicy).not.toBe(baseline);
    expect(otherArea).not.toBe(baseline);
  });

  it("rejects unsupported, malformed, and tampered fingerprints", () => {
    const fingerprint = createFindingFingerprint(fingerprintInput());

    expect(() => parseFindingFingerprint({ ...fingerprint, version: 2 })).toThrow(
      "Finding fingerprint version must be 1.",
    );
    expect(() => parseFindingFingerprint({ ...fingerprint, value: "sha256:not-a-hash" })).toThrow(
      "not supported",
    );
    expect(() =>
      parseFindingFingerprint({
        ...fingerprint,
        components: { ...(fingerprint.components as object), summary: "tampered" },
      }),
    ).toThrow("does not match components");
  });
});
