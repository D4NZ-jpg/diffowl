import { expect, it } from "vitest";

import { parseReviewRequestLedger } from "../src/review-request-state.js";

function event(overrides: Record<string, unknown> = {}) {
  return {
    eventId: "event",
    actor: "author",
    command: "review",
    observedAt: "2026-08-15T00:00:00.000Z",
    headSha: "head-sha",
    decision: "dispatch",
    requestId: "event",
    ...overrides,
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "event",
    headSha: "head-sha",
    status: "terminal",
    requestedAt: "2026-08-15T00:00:00.000Z",
    completedAt: "2026-08-15T00:01:00.000Z",
    ...overrides,
  };
}

it("rejects an invalid terminal timestamp instead of bypassing cooldown", () => {
  expect(() =>
    parseReviewRequestLedger({
      version: 1,
      events: { event: event() },
      requests: { event: request({ completedAt: "not-a-time" }) },
    }),
  ).toThrow('Review request "event" is invalid.');
});

it("rejects a command event that references missing request state", () => {
  expect(() =>
    parseReviewRequestLedger({ version: 1, events: { event: event() }, requests: {} }),
  ).toThrow('Review request event "event" has an invalid request reference.');
});
