/**
 * Shape checks for values that reach a git argv. git treats a leading dash as
 * an option and accepts revision syntax like `:/pattern` or `HEAD~3`, so a
 * value that came from a workflow input, an event payload, or a model must be
 * proven to be a plain object id or a plain relative path before it is used.
 * Callers also pass `--` where git supports it; these checks are the layer
 * that holds when a call site forgets.
 */

export class GitArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitArgumentError";
  }
}

const objectId = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u;

/** A full SHA-1 or SHA-256 object id, lower-case hex, nothing else. */
export function assertObjectId(value: string, label = "revision"): string {
  if (!objectId.test(value)) {
    throw new GitArgumentError(`${label} must be a full lower-case hex object id.`);
  }
  return value;
}

/**
 * A relative repository path: no leading dash, no absolute or drive prefix,
 * no `..` segment, no NUL, no empty segment, and not a git revision spec.
 */
export function assertRepositoryPath(value: string, label = "path"): string {
  if (
    value.length === 0 ||
    value.length > 4096 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.includes("\0") ||
    value.includes(":") ||
    value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new GitArgumentError(`${label} must be a plain relative repository path.`);
  }
  return value;
}
