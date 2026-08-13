export interface PublisherValidation {
  schemaValid: boolean;
  sizeWithinLimit: boolean;
  sourceRunVerified: boolean;
  headShaMatches: boolean;
  surfacesAllowed: boolean;
  resultCurrent: boolean;
}

export type TrustContext =
  | {
      type: "github_pull_request";
      repository: string;
      headRepository: string;
      actor: string | undefined;
    }
  | { type: "local_cli" }
  | { type: "privileged_publisher"; validation: PublisherValidation }
  | { type: "unsupported"; reason: string };

export interface TrustCapabilities {
  validationCommands: "sandboxed" | "local_user_authorized" | "denied";
  secrets: "local_user_authorized" | "publisher_token_only" | "denied";
  writeTokens: "local_user_authorized" | "publisher_token_only" | "denied";
  privilegedTools: "local_user_authorized" | "denied";
  publishing: "sha_bound_data_only" | "denied";
}

export type TrustClassification =
  | {
      class: "trusted_same_repo_pull_request";
      capabilities: TrustCapabilities;
    }
  | {
      class: "untrusted_pull_request";
      source: "fork" | "dependabot";
      capabilities: TrustCapabilities;
    }
  | {
      class: "local_cli";
      capabilities: TrustCapabilities;
    }
  | {
      class: "privileged_publisher";
      capabilities: TrustCapabilities;
    }
  | {
      class: "unsafe_or_unsupported";
      reason: string;
      capabilities: TrustCapabilities;
    };

const deniedCapabilities: TrustCapabilities = {
  validationCommands: "denied",
  secrets: "denied",
  writeTokens: "denied",
  privilegedTools: "denied",
  publishing: "denied",
};

function classifyPublisher(validation: PublisherValidation): TrustClassification {
  const validated =
    validation.schemaValid &&
    validation.sizeWithinLimit &&
    validation.sourceRunVerified &&
    validation.headShaMatches &&
    validation.surfacesAllowed &&
    validation.resultCurrent;
  if (!validated) {
    return {
      class: "unsafe_or_unsupported",
      reason: "Privileged publishing requires complete data-only validation.",
      capabilities: deniedCapabilities,
    };
  }
  return {
    class: "privileged_publisher",
    capabilities: {
      ...deniedCapabilities,
      secrets: "publisher_token_only",
      writeTokens: "publisher_token_only",
      publishing: "sha_bound_data_only",
    },
  };
}

export function classifyTrust(context: TrustContext): TrustClassification {
  if (context.type === "unsupported") {
    return {
      class: "unsafe_or_unsupported",
      reason: context.reason,
      capabilities: deniedCapabilities,
    };
  }

  if (context.type === "local_cli") {
    return {
      class: "local_cli",
      capabilities: {
        validationCommands: "local_user_authorized",
        secrets: "local_user_authorized",
        writeTokens: "local_user_authorized",
        privilegedTools: "local_user_authorized",
        publishing: "denied",
      },
    };
  }

  if (context.type === "privileged_publisher") {
    return classifyPublisher(context.validation);
  }

  if (context.actor === "dependabot[bot]") {
    return {
      class: "untrusted_pull_request",
      source: "dependabot",
      capabilities: deniedCapabilities,
    };
  }

  if (context.headRepository !== context.repository) {
    return {
      class: "untrusted_pull_request",
      source: "fork",
      capabilities: deniedCapabilities,
    };
  }

  return {
    class: "trusted_same_repo_pull_request",
    capabilities: {
      ...deniedCapabilities,
      validationCommands: "sandboxed",
    },
  };
}
