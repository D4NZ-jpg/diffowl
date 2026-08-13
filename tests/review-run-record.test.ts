import { expect, it } from "vitest";

import type { ProjectPolicy } from "../src/project-policy.js";
import type { ReviewOutcome } from "../src/review-outcome.js";
import {
  canonicalPolicyHash,
  createReviewRunRecord,
  parseReviewRunRecord,
  safeReviewOutcome,
} from "../src/review-run-record.js";
import { projectPolicy, reviewedPullRequest, trustedSameRepoTrust } from "./review-fixtures.js";
import { cleanOutcome, createRecord, policySource } from "./review-run-record-fixtures.js";

it("hashes policy canonically", () => {
  const left = projectPolicy({ scope: { includePaths: ["src/**"], excludePaths: ["dist/**"] } });
  const right: ProjectPolicy = {
    roleProfiles: left.roleProfiles,
    verification: left.verification,
    limits: left.limits,
    scope: left.scope,
    version: left.version,
  };
  expect(canonicalPolicyHash(left)).toBe(canonicalPolicyHash(right));
});

it("projects safe non-recursive run metadata", () => {
  const policy = projectPolicy({
    verification: { validationCommands: [{ argv: ["npm", "test"], timeoutSeconds: 30 }] },
  });
  const outcome = cleanOutcome(policy);
  const record = createReviewRunRecord({
    runId: "run-1",
    recordedAt: "2026-01-02T03:04:05.000Z",
    engineVersion: "0.1.0-test",
    revision: { pullRequest: reviewedPullRequest, mergeBaseSha: reviewedPullRequest.baseSha },
    trust: trustedSameRepoTrust,
    policy,
    validationAttempts: [
      {
        commandIndex: 0,
        argv: ["curl", "-H", "Authorization: Bearer secret-token"],
        timeoutSeconds: 30,
        status: "failed",
        exitCode: 1,
        stdout: "do not persist stdout",
        stderr: "do not persist stderr",
        truncated: true,
        limitation: "secret limitation",
      },
    ],
    finalOutcome: outcome,
  });
  const serialized = JSON.stringify(record);

  expect(record).toMatchObject({
    version: 1,
    trustClass: "trusted_same_repo_pull_request",
    policyStatus: "valid",
    budget: { reviewTimeoutSeconds: 600, maxFindings: 25, validationCommandCount: 1 },
    validationAttempts: [{ limitation: true }],
    finalOutcome: { type: "clean", validationAttemptCount: 1, executionArtifactCount: 3 },
  });
  for (const secret of [
    "credentialProfile",
    "do not persist",
    "secret-token",
    "secret limitation",
    "argv",
    "executionArtifacts",
  ]) {
    expect(serialized).not.toContain(secret);
  }
});

it("redacts unsafe provider metadata with consistent UTF-16 bounds", () => {
  const cases = [
    "ghp_abcdefghijklmnopqrstuvwxyz",
    "github_pat_secret",
    "AKIA1234567890ABCDEF",
    "😀".repeat(101),
  ];
  for (const provider of cases) {
    const policy = projectPolicy();
    policy.roleProfiles.reviewer.provider = provider;
    const record = createRecord(cleanOutcome(policy), policy);
    expect(record.providerModels.find(({ role }) => role === "reviewer")?.provider).toBe(
      "[redacted]",
    );
    expect(parseReviewRunRecord(record)).toEqual(record);
  }
});

it("rejects unsafe metadata loaded from persistence", () => {
  const record = createRecord(cleanOutcome(projectPolicy()), projectPolicy());
  expect(() =>
    parseReviewRunRecord({
      ...record,
      providerModels: [
        { role: "reviewer", provider: "ghp_abcdefghijklmnopqrstuvwxyz", model: "m" },
      ],
    }),
  ).toThrow("not supported");
});

it("strictly validates budget and policy-status consistency", () => {
  const policy = projectPolicy();
  const record = createRecord(cleanOutcome(policy), policy);
  expect(() => parseReviewRunRecord({ ...record, budget: undefined })).toThrow("not supported");
  expect(() =>
    parseReviewRunRecord({ ...record, budget: { ...record.budget, maxFindings: 0 } }),
  ).toThrow("not supported");
  expect(() =>
    parseReviewRunRecord({ ...record, policyStatus: "unavailable", budget: record.budget }),
  ).toThrow("not supported");
});

it("retains typed timeout fields without arbitrary diagnostics", () => {
  const policy = projectPolicy();
  const timeout: ReviewOutcome = {
    type: "timeout",
    trust: trustedSameRepoTrust,
    pullRequest: reviewedPullRequest,
    policy: { source: policySource, effective: policy },
    timeoutSeconds: 90,
    executionArtifacts: [],
  };
  expect(safeReviewOutcome(timeout)).toMatchObject({
    type: "timeout",
    timeoutSeconds: 90,
    diagnosticPresent: false,
  });
});

it("records failures before policy is available without persisting secrets", () => {
  const outcome: ReviewOutcome = {
    type: "configuration_failure",
    trust: trustedSameRepoTrust,
    pullRequest: reviewedPullRequest,
    reason: "Bearer secret-token was rejected",
    policySource,
  };
  const record = createReviewRunRecord({
    runId: "failed-run",
    recordedAt: "2026-01-02T03:04:05.000Z",
    engineVersion: "test",
    validationAttempts: [],
    unavailablePolicyContents: '{"apiKey":"secret-token"}',
    finalOutcome: outcome,
  });
  expect(record).toMatchObject({
    policyStatus: "unavailable",
    finalOutcome: { diagnosticPresent: true },
  });
  expect(record.policyHash).toMatch(/^sha256:/u);
  expect(JSON.stringify(record)).not.toContain("secret-token");
  expect(parseReviewRunRecord(record)).toEqual(record);
});

it("rejects mismatched and corrupt run records", () => {
  const policy = projectPolicy();
  expect(() =>
    createRecord(
      cleanOutcome(policy),
      projectPolicy({ limits: { reviewTimeoutSeconds: 1, maxFindings: 1 } }),
    ),
  ).toThrow("policy does not match");
  expect(() => parseReviewRunRecord({ version: 2, runId: "run-1" })).toThrow("version must be 1");
  expect(() =>
    parseReviewRunRecord({
      ...createRecord(cleanOutcome(policy), policy),
      recordedAt: "not-a-date",
    }),
  ).toThrow("not supported");
});
