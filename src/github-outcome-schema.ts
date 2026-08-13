import { z } from "zod";

import type { ReviewOutcome } from "./review-engine.js";

const nonEmptyString = z.string().min(1);
const positiveInteger = z.number().int().positive();
const nonNegativeInteger = z.number().int().nonnegative();

const capabilitiesSchema = z.strictObject({
  validationCommands: z.enum(["sandboxed", "local_user_authorized", "denied"]),
  secrets: z.enum([
    "provider_credentials_only",
    "local_user_authorized",
    "publisher_token_only",
    "denied",
  ]),
  writeTokens: z.enum(["local_user_authorized", "publisher_token_only", "denied"]),
  privilegedTools: z.enum(["local_user_authorized", "denied"]),
  publishing: z.enum(["sha_bound_data_only", "denied"]),
});

const deniedCapabilities = capabilitiesSchema.extend({
  validationCommands: z.literal("denied"),
  secrets: z.literal("denied"),
  writeTokens: z.literal("denied"),
  privilegedTools: z.literal("denied"),
  publishing: z.literal("denied"),
});

const trustSchema = z.discriminatedUnion("class", [
  z.strictObject({
    class: z.literal("trusted_same_repo_pull_request"),
    capabilities: deniedCapabilities.extend({
      validationCommands: z.literal("sandboxed"),
      secrets: z.literal("provider_credentials_only"),
    }),
  }),
  z.strictObject({
    class: z.literal("untrusted_pull_request"),
    source: z.enum(["fork", "dependabot"]),
    capabilities: deniedCapabilities,
  }),
  z.strictObject({
    class: z.literal("local_cli"),
    capabilities: capabilitiesSchema.extend({
      validationCommands: z.literal("local_user_authorized"),
      secrets: z.literal("local_user_authorized"),
      writeTokens: z.literal("local_user_authorized"),
      privilegedTools: z.literal("local_user_authorized"),
      publishing: z.literal("denied"),
    }),
  }),
  z.strictObject({
    class: z.literal("privileged_publisher"),
    capabilities: capabilitiesSchema.extend({
      validationCommands: z.literal("denied"),
      secrets: z.literal("publisher_token_only"),
      writeTokens: z.literal("publisher_token_only"),
      privilegedTools: z.literal("denied"),
      publishing: z.literal("sha_bound_data_only"),
    }),
  }),
  z.strictObject({
    class: z.literal("unsafe_or_unsupported"),
    reason: nonEmptyString,
    capabilities: deniedCapabilities,
  }),
]);

const pullRequestSchema = z.strictObject({
  repository: nonEmptyString,
  number: positiveInteger,
  baseSha: nonEmptyString,
  headSha: nonEmptyString,
});

const policySourceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("trusted_base_branch"),
    revision: nonEmptyString,
    path: z.literal(".diffowl.json"),
  }),
  z.strictObject({ type: z.literal("local_invocation"), path: nonEmptyString }),
]);

const roleProfileSchema = z.strictObject({
  provider: nonEmptyString,
  model: nonEmptyString,
  credentialProfile: nonEmptyString,
});
const projectPolicySchema = z.strictObject({
  version: z.literal(1),
  scope: z.strictObject({
    includePaths: z.array(nonEmptyString),
    excludePaths: z.array(nonEmptyString),
  }),
  limits: z.strictObject({ reviewTimeoutSeconds: positiveInteger, maxFindings: positiveInteger }),
  verification: z.strictObject({
    validationCommands: z.array(
      z.strictObject({
        argv: z.tuple([nonEmptyString], nonEmptyString),
        timeoutSeconds: positiveInteger,
      }),
    ),
  }),
  roleProfiles: z.strictObject({
    reviewer: roleProfileSchema,
    challenger: roleProfileSchema,
    verifier: roleProfileSchema,
  }),
});

const locationSchema = z.strictObject({
  path: nonEmptyString,
  line: positiveInteger.optional(),
});
const evidenceSchema = z.discriminatedUnion("type", [
  z.strictObject({
    id: nonEmptyString,
    type: z.literal("scoped_diff"),
    path: nonEmptyString,
    content: z.string(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    id: nonEmptyString,
    type: z.literal("repository_file"),
    path: nonEmptyString,
    content: z.string(),
    truncated: z.boolean(),
  }),
  z.strictObject({
    id: nonEmptyString,
    type: z.literal("validation"),
    commandIndex: nonNegativeInteger,
    content: z.string(),
    truncated: z.boolean(),
  }),
]);
const verificationStateSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("verified"),
    explanation: nonEmptyString,
    limitations: z.tuple([]),
  }),
  z.strictObject({
    type: z.literal("verified_with_limitations"),
    explanation: nonEmptyString,
    limitations: z.array(nonEmptyString),
  }),
]);
const findingSchema = z.strictObject({
  summary: nonEmptyString,
  location: locationSchema,
  impact: nonEmptyString,
  evidence: z.array(evidenceSchema),
  lifecycleState: z.enum([
    "new",
    "persisting",
    "resolved",
    "obsolete",
    "rebutted",
    "accepted",
    "suppressed",
  ]),
  verificationState: verificationStateSchema,
});
const advisorySchema = z.strictObject({
  summary: nonEmptyString,
  rationale: nonEmptyString,
  location: locationSchema.optional(),
});

const validationAttemptSchema = z.strictObject({
  commandIndex: nonNegativeInteger,
  argv: z.array(nonEmptyString),
  timeoutSeconds: positiveInteger,
  status: z.enum(["passed", "failed", "timed_out", "aborted", "error"]),
  exitCode: z.number().int().optional(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  limitation: z.string().optional(),
});
const verificationContextSchema = z.strictObject({
  evidenceCatalog: z.array(evidenceSchema),
  validationAttempts: z.array(validationAttemptSchema),
  limitations: z.array(z.string()),
  coverageGaps: z.array(z.string()),
});
const orchestrationPlanSchema = z.strictObject({
  maxCandidateFindings: nonNegativeInteger,
  steps: z.array(
    z.discriminatedUnion("role", [
      z.strictObject({ role: z.literal("reviewer"), purpose: z.literal("generate_candidates") }),
      z.strictObject({ role: z.literal("challenger"), purpose: z.literal("challenge_candidates") }),
      z.strictObject({ role: z.literal("verifier"), purpose: z.literal("verify_candidates") }),
    ]),
  ),
});
const artifactSchema = z.strictObject({
  role: z.enum(["reviewer", "challenger", "verifier"]),
  snapshot: z.strictObject({
    version: z.literal(1),
    files: z.array(z.strictObject({ path: nonEmptyString, data: z.string() })),
  }),
  events: z.array(
    z.strictObject({
      type: z.enum(["tool_call", "tool_result", "file_change", "repair", "finish", "error"]),
      detail: z.unknown(),
    }),
  ),
  files: z.array(
    z.strictObject({
      path: nonEmptyString,
      change: z.enum(["create", "modify"]),
      bytes: z.instanceof(Uint8Array),
    }),
  ),
  sessionId: z.string(),
  finishReason: nonEmptyString,
});

const outcomeBase = { trust: trustSchema };
const pullRequestBase = { ...outcomeBase, pullRequest: pullRequestSchema };
const configuredBase = {
  ...pullRequestBase,
  policy: z.strictObject({ source: policySourceSchema, effective: projectPolicySchema }),
};
const completedBase = {
  ...configuredBase,
  coverage: z.literal("completed_permitted"),
  advisorySuggestions: z.array(advisorySchema),
  verification: verificationContextSchema,
  orchestrationPlan: orchestrationPlanSchema,
  executionArtifacts: z.array(artifactSchema),
};

export const githubReviewOutcomeSchema = z.discriminatedUnion("type", [
  z.strictObject({ ...outcomeBase, type: z.literal("policy_skip"), reason: nonEmptyString }),
  z.strictObject({ ...outcomeBase, type: z.literal("unsupported_change"), reason: nonEmptyString }),
  z.strictObject({ ...completedBase, type: z.literal("clean"), materialFindings: z.tuple([]) }),
  z.strictObject({
    ...completedBase,
    type: z.literal("findings"),
    materialFindings: z.array(findingSchema).min(1),
  }),
  z.strictObject({
    ...configuredBase,
    type: z.literal("abstention"),
    reason: nonEmptyString,
    materialFindings: z.array(findingSchema),
    advisorySuggestions: z.array(advisorySchema),
    verification: verificationContextSchema,
    executionArtifacts: z.array(artifactSchema),
  }),
  z.strictObject({
    ...configuredBase,
    type: z.literal("partial_coverage"),
    reason: nonEmptyString,
    materialFindings: z.array(findingSchema).optional(),
    advisorySuggestions: z.array(advisorySchema).optional(),
    verification: verificationContextSchema.optional(),
    orchestrationPlan: orchestrationPlanSchema.optional(),
    executionArtifacts: z.array(artifactSchema).optional(),
  }),
  ...(["provider_failure", "budget_limit", "resource_limit"] as const).map((type) =>
    z.strictObject({
      ...configuredBase,
      type: z.literal(type),
      reason: nonEmptyString,
      executionArtifacts: z.array(artifactSchema),
    }),
  ),
  z.strictObject({
    ...configuredBase,
    type: z.literal("timeout"),
    timeoutSeconds: positiveInteger,
    executionArtifacts: z.array(artifactSchema),
  }),
  z.strictObject({
    ...pullRequestBase,
    type: z.literal("configuration_failure"),
    reason: nonEmptyString,
    policySource: policySourceSchema,
  }),
  z.strictObject({
    ...configuredBase,
    type: z.literal("internal_failure"),
    reason: nonEmptyString,
  }),
]);

export function parseGitHubReviewOutcome(value: unknown): ReviewOutcome | undefined {
  const result = githubReviewOutcomeSchema.safeParse(value);
  return result.success ? (result.data as ReviewOutcome) : undefined;
}
