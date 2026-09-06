import { type RepositoryPermission, writableRepositoryPermissions } from "./trust.js";

export interface FindingCommandAuthorizationEvent {
  repository: string;
  actor: string;
}

export interface FindingCommandAuthorizationPullRequest {
  author: string;
  baseRepository: string;
  headRepository: string;
}

/**
 * How a pull-request head may be admitted for privileged work. The base
 * repository must always match the event repository. A fork head is admitted
 * only when base-branch policy trusts collaborator forks and the author's
 * permission on the base repository, read from GitHub by the caller, is
 * write, maintain, or admin.
 */
export interface HeadAdmission {
  collaboratorForksTrusted: boolean;
  authorPermission: RepositoryPermission;
}

export const sameRepositoryOnly: HeadAdmission = {
  collaboratorForksTrusted: false,
  authorPermission: "none",
};

export function headAdmitted(
  event: { repository: string },
  pullRequest: { baseRepository: string; headRepository: string },
  admission: HeadAdmission,
): boolean {
  if (pullRequest.baseRepository !== event.repository) return false;
  if (pullRequest.headRepository === event.repository) return true;
  return (
    admission.collaboratorForksTrusted &&
    writableRepositoryPermissions.has(admission.authorPermission)
  );
}

const dependabotLogin = /^dependabot(?:\[bot\])?$/iu;

export function findingCommandAuthorizationReason(
  event: FindingCommandAuthorizationEvent,
  pullRequest: FindingCommandAuthorizationPullRequest,
  admission: HeadAdmission = sameRepositoryOnly,
): string | undefined {
  if (!headAdmitted(event, pullRequest, admission)) {
    return "Diffowl only accepts Finding commands for same-repository pull requests, or fork pull requests whose author has write access when policy trusts collaborator forks.";
  }
  if (dependabotLogin.test(pullRequest.author) || dependabotLogin.test(event.actor)) {
    return "Diffowl does not accept privileged Finding commands from Dependabot.";
  }
  return event.actor === pullRequest.author
    ? undefined
    : "Diffowl Finding commands must be authored by the pull-request author.";
}
