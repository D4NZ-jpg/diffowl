const fingerprintPattern = /sha256:[\da-f]{64}/iu;
const commandPattern =
  /^\/(?:diffowl|review-owl)\s+(accept|rebut|suppress|ignore|resolved|resolve|recheck|rerun|explain|reassess)(?:\s+([\s\S]*))?$/imu;

export type FindingDispositionState = "accepted" | "rebutted" | "suppressed";

export type FindingDiscussionCommand =
  | "accept"
  | "rebut"
  | "suppress"
  | "ignore"
  | "resolved"
  | "recheck"
  | "rerun"
  | "explain"
  | "reassess";

export interface FindingDiscussionComment {
  id: string | number;
  actor: string;
  body: string;
  createdAt: string;
  findingFingerprint?: string | undefined;
  threadBody?: string | undefined;
  source?: string | undefined;
}

export interface FindingDiscussionEvent {
  id: string;
  fingerprint: string;
  actor: string;
  command: FindingDiscussionCommand;
  createdAt: string;
  body?: string | undefined;
  source?: string | undefined;
}

export interface FindingDiscussionEffects {
  dispositions?: Readonly<Record<string, FindingDispositionState>> | undefined;
  resolvedFingerprints?: readonly string[] | undefined;
  reassessedFingerprints?: readonly string[] | undefined;
  events: FindingDiscussionEvent[];
}

export interface RecognizeFindingDiscussionOptions {
  authorLogins?: readonly string[] | undefined;
}

export function findingIdentityMarker(fingerprint: string): string {
  return `<!-- diffowl:finding:v1 fingerprint=${fingerprint} -->`;
}

function findingFingerprint(comment: FindingDiscussionComment): string | undefined {
  const candidates = [comment.findingFingerprint, comment.threadBody, comment.body];
  for (const candidate of candidates) {
    const match = candidate?.match(fingerprintPattern);
    if (match?.[0] !== undefined) return match[0].toLowerCase();
  }
  return undefined;
}

function normalizedCommand(value: string): FindingDiscussionCommand {
  return value.toLowerCase() === "resolve"
    ? "resolved"
    : (value.toLowerCase() as FindingDiscussionCommand);
}

function addUnique(values: Set<string>, fingerprint: string): void {
  values.add(fingerprint);
}

function applyLifecycleEffect(
  event: FindingDiscussionEvent,
  dispositions: Record<string, FindingDispositionState>,
  resolved: Set<string>,
  reassessed: Set<string>,
): void {
  if (event.command === "accept") dispositions[event.fingerprint] = "accepted";
  else if (event.command === "rebut") dispositions[event.fingerprint] = "rebutted";
  else if (event.command === "suppress" || event.command === "ignore") {
    dispositions[event.fingerprint] = "suppressed";
  } else if (event.command === "resolved") addUnique(resolved, event.fingerprint);
  else if (
    event.command === "recheck" ||
    event.command === "rerun" ||
    event.command === "reassess"
  ) {
    addUnique(reassessed, event.fingerprint);
  }
}

function bodyForEvent(
  command: FindingDiscussionCommand,
  body: string | undefined,
): string | undefined {
  const requiresBody = ["rebut", "suppress", "ignore", "reassess"].includes(command);
  if (body === undefined || body === "") return requiresBody ? undefined : "";
  return body;
}

function eventFrom(
  comment: FindingDiscussionComment,
  fingerprint: string,
  command: FindingDiscussionCommand,
  body: string | undefined,
): FindingDiscussionEvent {
  return {
    id: String(comment.id),
    fingerprint,
    actor: comment.actor,
    command,
    createdAt: comment.createdAt,
    ...(body === undefined || body === "" ? {} : { body }),
    ...(comment.source === undefined ? {} : { source: comment.source }),
  };
}

function recognizedEvent(
  comment: FindingDiscussionComment,
  authors: ReadonlySet<string> | undefined,
): FindingDiscussionEvent | undefined {
  if (authors !== undefined && !authors.has(comment.actor)) return undefined;
  const command = comment.body.match(commandPattern)?.[1];
  if (command === undefined) return undefined;
  const normalized = normalizedCommand(command);
  const body = bodyForEvent(normalized, comment.body.match(commandPattern)?.[2]?.trim());
  const fingerprint = findingFingerprint(comment);
  return fingerprint === undefined || body === undefined
    ? undefined
    : eventFrom(comment, fingerprint, normalized, body);
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
    "rerun",
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

export function recognizeFindingDiscussionCommands(
  comments: readonly FindingDiscussionComment[],
  options: RecognizeFindingDiscussionOptions = {},
): FindingDiscussionEffects {
  const authors = options.authorLogins === undefined ? undefined : new Set(options.authorLogins);
  const dispositions: Record<string, FindingDispositionState> = {};
  const resolved = new Set<string>();
  const reassessed = new Set<string>();
  const events: FindingDiscussionEvent[] = [];
  for (const comment of comments) {
    const event = recognizedEvent(comment, authors);
    if (event === undefined) continue;
    events.push(event);
    applyLifecycleEffect(event, dispositions, resolved, reassessed);
  }
  return {
    ...(Object.keys(dispositions).length === 0 ? {} : { dispositions }),
    ...(resolved.size === 0 ? {} : { resolvedFingerprints: [...resolved] }),
    ...(reassessed.size === 0 ? {} : { reassessedFingerprints: [...reassessed] }),
    events,
  };
}
