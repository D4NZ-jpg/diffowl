const commandPattern =
  /^\/(?:diffowl|review-owl)\s+(accept|rebut|suppress|ignore|resolved|resolve|recheck|explain|reassess)(?:[ \t]+([^\r\n]*))?$/iu;

export type FindingDiscussionCommand =
  | "accept"
  | "rebut"
  | "suppress"
  | "ignore"
  | "resolved"
  | "recheck"
  | "explain"
  | "reassess";

export interface FindingDiscussionEvent {
  id: string;
  fingerprint: string;
  actor: string;
  command: FindingDiscussionCommand;
  createdAt: string;
  body?: string | undefined;
  source?: string | undefined;
}

export interface ParsedFindingDiscussionCommand {
  command: FindingDiscussionCommand;
  body?: string | undefined;
}

export function findingIdentityMarker(fingerprint: string): string {
  return `<!-- diffowl:finding:v1 fingerprint=${fingerprint} -->`;
}

function normalizedCommand(value: string): FindingDiscussionCommand {
  return value.toLowerCase() === "resolve"
    ? "resolved"
    : (value.toLowerCase() as FindingDiscussionCommand);
}

function bodyForEvent(
  command: FindingDiscussionCommand,
  body: string | undefined,
): string | undefined {
  const requiresBody = ["rebut", "suppress", "ignore", "reassess"].includes(command);
  if (body === undefined || body === "") return requiresBody ? undefined : "";
  return body;
}

export function parseFindingDiscussionCommandBody(
  value: string,
): ParsedFindingDiscussionCommand | undefined {
  const match = value.match(commandPattern);
  const command = match?.[1];
  if (command === undefined) return undefined;
  const normalized = normalizedCommand(command);
  const suppliedBody = match?.[2]?.trim();
  if (normalized === "recheck" && suppliedBody !== undefined && suppliedBody !== "") {
    return undefined;
  }
  const body = bodyForEvent(normalized, suppliedBody);
  return body === undefined
    ? undefined
    : {
        command: normalized,
        ...(body === "" ? {} : { body }),
      };
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

export function parseFindingDiscussionEvent(value: unknown): FindingDiscussionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Finding discussion event must be an object.");
  }
  const event = value as Record<string, unknown>;
  const validStrings = [event.id, event.fingerprint, event.actor, event.createdAt].every(
    (field) => typeof field === "string" && field.length > 0,
  );
  const commands = [
    "accept",
    "rebut",
    "suppress",
    "ignore",
    "resolved",
    "recheck",
    "explain",
    "reassess",
  ];
  if (
    !validStrings ||
    typeof event.command !== "string" ||
    !commands.includes(event.command) ||
    !optionalString(event.body) ||
    !optionalString(event.source)
  ) {
    throw new Error("Finding discussion event is invalid.");
  }
  return value as FindingDiscussionEvent;
}
