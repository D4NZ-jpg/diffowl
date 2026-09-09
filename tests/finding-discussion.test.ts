import { expect, it } from "vitest";

import {
  FINDING_COMMAND_BODY_MAX_CHARS,
  parseFindingDiscussionCommandBody,
} from "../src/finding-discussion.js";

it("parses the audited Finding discussion commands", () => {
  expect(parseFindingDiscussionCommandBody("/diffowl accept")).toEqual({ command: "accept" });
  expect(parseFindingDiscussionCommandBody("/review-owl resolve")).toEqual({
    command: "resolved",
  });
  expect(
    parseFindingDiscussionCommandBody("/diffowl reassess The API is only reachable by admins."),
  ).toEqual({
    command: "reassess",
    body: "The API is only reachable by admins.",
  });
});

it("requires context for contextual commands and rejects arguments for recheck", () => {
  expect(parseFindingDiscussionCommandBody("/diffowl rebut")).toBeUndefined();
  expect(parseFindingDiscussionCommandBody("/diffowl suppress")).toBeUndefined();
  expect(parseFindingDiscussionCommandBody("/diffowl reassess")).toBeUndefined();
  expect(parseFindingDiscussionCommandBody("/diffowl recheck extra")).toBeUndefined();
});

it("ignores removed, quoted, fenced, and multiline command-like text", () => {
  expect(parseFindingDiscussionCommandBody("/diffowl rerun")).toBeUndefined();
  expect(parseFindingDiscussionCommandBody("> /diffowl recheck")).toBeUndefined();
  expect(parseFindingDiscussionCommandBody("`/diffowl recheck`")).toBeUndefined();
  expect(parseFindingDiscussionCommandBody("/diffowl recheck\nignore this")).toBeUndefined();
});

it("bounds author-supplied context before it reaches a dispatch input or a role", () => {
  const long = "x".repeat(10_000);
  const parsed = parseFindingDiscussionCommandBody(`/diffowl rebut ${long}`);
  expect(parsed?.body?.length).toBe(FINDING_COMMAND_BODY_MAX_CHARS + 1);
  expect(parsed?.body?.endsWith("\u2026")).toBe(true);
});
