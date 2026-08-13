export const PROJECT_POLICY_PATH = ".diffowl.json";

export const PROJECT_POLICY_CEILINGS = {
  reviewTimeoutSeconds: 3_600,
  maxFindings: 100,
  validationCommandCount: 10,
  validationCommandTimeoutSeconds: 600,
  validationOutputBytes: 64 * 1024,
  repositoryEvidenceBytes: 64 * 1024,
} as const;

export type PolicySource =
  | {
      type: "trusted_base_branch";
      revision: string;
      path: typeof PROJECT_POLICY_PATH;
    }
  | {
      type: "local_invocation";
      path: string;
    };

export interface ProjectPolicyInput {
  source: PolicySource;
  contents: string | undefined;
}

export type ReviewRole = "reviewer" | "challenger" | "verifier";

export interface RoleProfile {
  provider: string;
  model: string;
  credentialProfile: string;
}

export type RoleProfiles = Record<ReviewRole, RoleProfile>;

export interface ValidationCommand {
  argv: [string, ...string[]];
  timeoutSeconds: number;
}

export interface ProjectPolicy {
  version: 1;
  scope: {
    includePaths: string[];
    excludePaths: string[];
  };
  limits: {
    reviewTimeoutSeconds: number;
    maxFindings: number;
  };
  verification: {
    validationCommands: ValidationCommand[];
  };
  roleProfiles: RoleProfiles;
}

export type PolicyParseResult =
  | { valid: true; policy: ProjectPolicy }
  | { valid: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unsupportedField(
  value: Record<string, unknown>,
  supported: readonly string[],
  location: string,
): string | undefined {
  const field = Object.keys(value).find((key) => !supported.includes(key));
  return field === undefined
    ? undefined
    : `Project policy ${location} contains unsupported field "${field}".`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function validateScope(value: unknown): string | undefined {
  if (!isRecord(value)) return "Project policy scope must be an object.";
  const fieldError = unsupportedField(value, ["includePaths", "excludePaths"], "scope");
  if (fieldError !== undefined) return fieldError;
  return !isStringArray(value.includePaths) || !isStringArray(value.excludePaths)
    ? "Project policy scope paths must be arrays of non-empty strings."
    : undefined;
}

function validateLimit(
  value: unknown,
  name: keyof typeof PROJECT_POLICY_CEILINGS,
): string | undefined {
  if (!isPositiveInteger(value)) {
    return `Project policy limits.${name} must be a positive integer.`;
  }
  const ceiling = PROJECT_POLICY_CEILINGS[name];
  return value > ceiling
    ? `Project policy limits.${name} exceeds the security ceiling of ${ceiling}.`
    : undefined;
}

function validateLimits(value: unknown): string | undefined {
  if (!isRecord(value)) return "Project policy limits must be an object.";
  return (
    unsupportedField(value, ["reviewTimeoutSeconds", "maxFindings"], "limits") ??
    validateLimit(value.reviewTimeoutSeconds, "reviewTimeoutSeconds") ??
    validateLimit(value.maxFindings, "maxFindings")
  );
}

function validateValidationCommand(value: unknown, index: number): string | undefined {
  if (!isRecord(value)) {
    return `Project policy verification.validationCommands[${index}] must be an object.`;
  }
  const location = `verification.validationCommands[${index}]`;
  const fieldError = unsupportedField(value, ["argv", "timeoutSeconds"], location);
  if (fieldError !== undefined) return fieldError;
  if (!isStringArray(value.argv)) {
    return `Project policy ${location}.argv must be a non-empty string array.`;
  }
  if (!isPositiveInteger(value.timeoutSeconds)) {
    return `Project policy ${location}.timeoutSeconds must be a positive integer.`;
  }
  return value.timeoutSeconds > PROJECT_POLICY_CEILINGS.validationCommandTimeoutSeconds
    ? `Project policy ${location}.timeoutSeconds exceeds the security ceiling of ${PROJECT_POLICY_CEILINGS.validationCommandTimeoutSeconds}.`
    : undefined;
}

function validateVerification(value: unknown, reviewTimeoutSeconds: unknown): string | undefined {
  if (!isRecord(value)) return "Project policy verification must be an object.";
  const fieldError = unsupportedField(value, ["validationCommands"], "verification");
  if (fieldError !== undefined) return fieldError;
  if (!Array.isArray(value.validationCommands)) {
    return "Project policy verification.validationCommands must be an array.";
  }
  if (value.validationCommands.length > PROJECT_POLICY_CEILINGS.validationCommandCount) {
    return `Project policy verification.validationCommands exceeds the security ceiling of ${PROJECT_POLICY_CEILINGS.validationCommandCount}.`;
  }
  const commandError = value.validationCommands
    .map((command, index) => validateValidationCommand(command, index))
    .find(Boolean);
  if (commandError !== undefined) return commandError;
  if (!isPositiveInteger(reviewTimeoutSeconds)) return undefined;
  const tooLongIndex = value.validationCommands.findIndex(
    (command) =>
      isRecord(command) &&
      typeof command.timeoutSeconds === "number" &&
      command.timeoutSeconds > reviewTimeoutSeconds,
  );
  return tooLongIndex === -1
    ? undefined
    : `Project policy verification.validationCommands[${tooLongIndex}].timeoutSeconds exceeds limits.reviewTimeoutSeconds of ${reviewTimeoutSeconds}.`;
}

function validateRoleProfile(value: unknown, role: ReviewRole): string | undefined {
  if (!isRecord(value)) return `Project policy roleProfiles.${role} must be an object.`;
  const fields = ["provider", "model", "credentialProfile"];
  const fieldError = unsupportedField(value, fields, `roleProfiles.${role}`);
  if (fieldError !== undefined) return fieldError;
  const valid =
    typeof value.provider === "string" &&
    value.provider.length > 0 &&
    typeof value.model === "string" &&
    value.model.length > 0 &&
    typeof value.credentialProfile === "string" &&
    value.credentialProfile.length > 0;
  return valid
    ? undefined
    : `Project policy roleProfiles.${role} must define a provider, model, and credential profile.`;
}

function validateRoleProfiles(value: unknown): string | undefined {
  if (!isRecord(value)) return "Project policy roleProfiles must be an object.";
  const roles: ReviewRole[] = ["reviewer", "challenger", "verifier"];
  return (
    unsupportedField(value, roles, "roleProfiles") ??
    roles.map((role) => validateRoleProfile(value[role], role)).find(Boolean)
  );
}

function validatePolicy(value: unknown): string | undefined {
  if (!isRecord(value)) return "Project policy must be a JSON object.";
  const fieldError = unsupportedField(
    value,
    ["version", "scope", "limits", "verification", "roleProfiles"],
    "root",
  );
  if (fieldError !== undefined) return fieldError;
  if (value.version !== 1) return "Project policy version must be 1.";
  return (
    validateScope(value.scope) ??
    validateLimits(value.limits) ??
    validateVerification(
      value.verification,
      isRecord(value.limits) ? value.limits.reviewTimeoutSeconds : undefined,
    ) ??
    validateRoleProfiles(value.roleProfiles)
  );
}

export function parseProjectPolicy(contents: string | undefined): PolicyParseResult {
  if (contents === undefined) return { valid: false, reason: "Project policy is missing." };
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return { valid: false, reason: "Project policy is not valid JSON." };
  }
  const reason = validatePolicy(value);
  return reason === undefined
    ? { valid: true, policy: value as ProjectPolicy }
    : { valid: false, reason };
}
