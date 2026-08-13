import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { runAction } from "../src/action.js";

const eventPath = fileURLToPath(
  new URL("./fixtures/github-pull-request-event.json", import.meta.url),
);

const representativeDiff = [
  "diff --git a/message.txt b/message.txt",
  "index ce01362..94954ab 100644",
  "--- a/message.txt",
  "+++ b/message.txt",
  "@@ -1 +1 @@",
  "-hello",
  "+hello owl",
  "",
].join("\n");

describe("Review OWL Action", () => {
  it("runs the Review engine for a same-repo pull request", async () => {
    const outputs = new Map<string, string>();

    const outcome = await runAction(
      { GITHUB_EVENT_PATH: eventPath },
      {
        readFile,
        readDiff: async (baseSha, headSha) => {
          expect(baseSha).toBe("1111111111111111111111111111111111111111");
          expect(headSha).toBe("2222222222222222222222222222222222222222");
          return representativeDiff;
        },
        setOutput: async (name, value) => {
          outputs.set(name, value);
        },
      },
    );

    expect(outcome).toEqual({
      type: "partial_coverage",
      pullRequest: {
        repository: "example/review-target",
        number: 42,
        baseSha: "1111111111111111111111111111111111111111",
        headSha: "2222222222222222222222222222222222222222",
      },
      reason: "The tracer path does not analyze changes yet.",
    });
    expect(JSON.parse(outputs.get("outcome") ?? "")).toEqual(outcome);
  });
});
