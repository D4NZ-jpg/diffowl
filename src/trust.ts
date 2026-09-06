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
      /**
       * The pull-request author's verified permission on the base repository,
       * read from the collaborators API by the caller. Only consulted for fork
       * heads, and only when the base-branch policy opts in to collaborator
       * forks. Absent means unknown, which is treated as no permission.
       */
      authorPermission?: RepositoryPermission | undefined;
      collaboratorForksTrusted?: boolean | undefined;
    }
  | { type: "local_cli" }
  | { type: "privileged_publisher"; validation: PublisherValidation }
  | { type: "unsupported"; reason: string };

export interface TrustCapabilities {
  validationCommands: "sandboxed" | "local_user_authorized" | "denied";
  secrets:
    | "provider_credentials_only"
    | "local_user_authorized"
    | "publisher_token_only"
    | "denied";
  writeTokens: "local_user_authorized" | "publisher_token_only" | "denied";
  privilegedTools: "local_user_authorized" | "denied";
  publishing: "sha_bound_data_only" | "denied";
}

export type RepositoryPermission = "none" | "read" | "triage" | "write" | "maintain" | "admin";

export const writableRepositoryPermissions: ReadonlySet<RepositoryPermission> = new Set([
  "write",
  "maintain",
  "admin",
]);

export type TrustClassification =
  | {
      class: "trusted_same_repo_pull_request";
      capabilities: TrustCapabilities;
    }
  | {
      /**
       * A fork pull request whose author holds write, maintain, or admin
       * permission on the base repository, admitted by base-branch policy. Same
       * capabilities as a same-repository pull request; the class name is kept
       * distinct so run records and publication show how trust was granted.
       */
      class: "trusted_collaborator_fork_pull_request";
      authorPermission: RepositoryPermission;
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

  const pullRequestCapabilities: TrustCapabilities = {
    ...deniedCapabilities,
    validationCommands: "sandboxed",
    secrets: "provider_credentials_only",
  };

  if (context.headRepository !== context.repository) {
    const permission = context.authorPermission ?? "none";
    if (
      context.collaboratorForksTrusted === true &&
      writableRepositoryPermissions.has(permission)
    ) {
      return {
        class: "trusted_collaborator_fork_pull_request",
        authorPermission: permission,
        capabilities: pullRequestCapabilities,
      };
    }
    return {
      class: "untrusted_pull_request",
      source: "fork",
      capabilities: deniedCapabilities,
    };
  }

  return {
    class: "trusted_same_repo_pull_request",
    capabilities: pullRequestCapabilities,
  };
}

/** Pull-request trust classes that may run the review with provider credentials and publish. */
export function isTrustedPullRequest(trust: TrustClassification): boolean {
  return (
    trust.class === "trusted_same_repo_pull_request" ||
    trust.class === "trusted_collaborator_fork_pull_request"
  );
}
