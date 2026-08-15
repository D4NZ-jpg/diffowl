export function githubRecord(value: unknown, context: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} returned an invalid response.`);
  }
  return value as Record<string, unknown>;
}

export function githubText(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${context} returned an invalid response.`);
  }
  return value;
}

export function githubBodyHasMarker(value: unknown, marker: string): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).body === "string" &&
    ((value as Record<string, unknown>).body as string).includes(marker)
  );
}

export async function githubMarkerExists(
  marker: string,
  readPage: (page: number) => Promise<unknown>,
  context: string,
): Promise<boolean> {
  for (let page = 1; page <= 10; page += 1) {
    // Marker reconciliation is bounded to 1,000 comments.
    // oxlint-disable-next-line no-await-in-loop
    const response = await readPage(page);
    if (!Array.isArray(response)) throw new Error(`${context} returned an invalid response.`);
    if (response.some((comment) => githubBodyHasMarker(comment, marker))) return true;
    if (response.length < 100) return false;
  }
  throw new Error(`Unable to reconcile ${context} within 1,000 comments.`);
}
