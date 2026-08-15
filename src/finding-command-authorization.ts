export interface FindingCommandAuthorizationEvent {
  repository: string;
  actor: string;
}

export interface FindingCommandAuthorizationPullRequest {
  author: string;
  baseRepository: string;
  headRepository: string;
}

const dependabotLogin = /^dependabot(?:\[bot\])?$/iu;

export function findingCommandAuthorizationReason(
  event: FindingCommandAuthorizationEvent,
  pullRequest: FindingCommandAuthorizationPullRequest,
): string | undefined {
  if (
    pullRequest.baseRepository !== event.repository ||
    pullRequest.headRepository !== event.repository
  ) {
    return "Diffowl only accepts Finding commands for same-repository pull requests.";
  }
  if (dependabotLogin.test(pullRequest.author) || dependabotLogin.test(event.actor)) {
    return "Diffowl does not accept privileged Finding commands from Dependabot.";
  }
  return event.actor === pullRequest.author
    ? undefined
    : "Diffowl Finding commands must be authored by the pull-request author.";
}
