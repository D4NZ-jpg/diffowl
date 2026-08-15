import { expect, it } from "vitest";

import {
  findingIdentityMarker,
  recognizeFindingDiscussionCommands,
} from "../src/finding-discussion.js";

const fingerprint = `sha256:${"a".repeat(64)}`;

function comment(body: string, id = 1) {
  return {
    id,
    actor: "author",
    body,
    createdAt: "2026-01-01T00:00:00.000Z",
    threadBody: `${findingIdentityMarker(fingerprint)}\n### Review OWL material Finding`,
  };
}

it("recognizes audited lifecycle commands from Review OWL threads", () => {
  const effects = recognizeFindingDiscussionCommands([
    comment("/review-owl accept\nI will fix this in a follow-up."),
    comment("/diffowl reassess The API is only reachable by admins.", 2),
    comment("/review-owl explain", 3),
  ]);

  expect(effects.dispositions).toEqual({ [fingerprint]: "accepted" });
  expect(effects.reassessedFingerprints).toEqual([fingerprint]);
  expect(effects.events).toEqual([
    expect.objectContaining({ command: "accept", actor: "author", fingerprint }),
    expect.objectContaining({
      command: "reassess",
      body: "The API is only reachable by admins.",
    }),
    expect.objectContaining({ command: "explain" }),
  ]);
});

it("keeps the deprecated full-review alias out of Finding discussion effects", () => {
  const effects = recognizeFindingDiscussionCommands([
    comment("/review-owl ignore noisy in generated code"),
    comment("/review-owl suppress policy allows this", 2),
    comment("/review-owl resolved fixed in latest push", 3),
    comment("/review-owl recheck", 4),
    comment("/diffowl rerun", 5),
  ]);

  expect(effects.dispositions).toEqual({ [fingerprint]: "suppressed" });
  expect(effects.resolvedFingerprints).toEqual([fingerprint]);
  expect(effects.reassessedFingerprints).toEqual([fingerprint]);
  expect(effects.events.map((event) => event.command)).toEqual([
    "ignore",
    "suppress",
    "resolved",
    "recheck",
  ]);
});

it("only accepts author commands and reassessment with context", () => {
  expect(
    recognizeFindingDiscussionCommands(
      [
        comment("/review-owl accept", 1),
        { ...comment("/review-owl rebut", 2), actor: "reviewer" },
        comment("/review-owl reassess", 3),
      ],
      { authorLogins: ["author"] },
    ),
  ).toEqual({
    dispositions: { [fingerprint]: "accepted" },
    events: [expect.objectContaining({ command: "accept", actor: "author" })],
  });
});

it("requires context for rebuttal and suppression commands", () => {
  expect(
    recognizeFindingDiscussionCommands([
      comment("/review-owl rebut"),
      comment("/review-owl suppress", 2),
    ]),
  ).toEqual({ events: [] });
});

it("ignores commands without a Finding identity", () => {
  expect(
    recognizeFindingDiscussionCommands([
      { id: 1, actor: "author", body: "/review-owl accept", createdAt: "2026-01-01" },
    ]),
  ).toEqual({ events: [] });
});
