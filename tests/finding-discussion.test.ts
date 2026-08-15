import { expect, it } from "vitest";

import { parseFindingDiscussionCommandBody } from "../src/finding-discussion.js";

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
