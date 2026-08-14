import { createHash } from "node:crypto";

import type {
  FindingLifecycleState,
  MaterialFinding,
  ReviewOutcome,
  ValidationAttempt,
} from "./review-engine.js";
import { findingIdentityMarker } from "./finding-discussion.js";
import { truncateUtf8 } from "./utf8.js";

export type GitHubCheckConclusion =
  | "action_required"
  | "failure"
  | "neutral"
  | "skipped"
  | "success"
  | "timed_out";

export const SUMMARY_MARKER = "<!-- diffowl:current-summary:v1 -->";
export const PUBLISHING_SUMMARY_MARKER = "<!-- diffowl:publishing-summary:v1";
export const SUPERSEDED_SUMMARY_MARKER = "<!-- diffowl:superseded-summary:v1 -->";
export const FINDING_COMMENT_MARKER = "### Review OWL material Finding";
export const SUPERSEDED_FINDING_MARKER = "<!-- diffowl:superseded-finding:v1 -->";
export const GITHUB_BODY_LIMIT = 60 * 1024;

const conclusions: Record<ReviewOutcome["type"], GitHubCheckConclusion> = {
  clean: "success",
  findings: "action_required",
  policy_skip: "skipped",
  unsupported_change: "skipped",
  partial_coverage: "neutral",
  abstention: "neutral",
  timeout: "timed_out",
  provider_failure: "failure",
  budget_limit: "failure",
  resource_limit: "failure",
  configuration_failure: "failure",
  internal_failure: "failure",
};

const lifecycleOrder: FindingLifecycleState[] = [
  "new",
  "persisting",
  "accepted",
  "resolved",
  "obsolete",
  "rebutted",
  "suppressed",
];

export function checkConclusion(outcome: ReviewOutcome): GitHubCheckConclusion {
  return conclusions[outcome.type];
}

export function materialFindings(outcome: ReviewOutcome): MaterialFinding[] {
  if (outcome.type === "findings" || outcome.type === "abstention") {
    return outcome.materialFindings;
  }
  return outcome.type === "partial_coverage" ? (outcome.materialFindings ?? []) : [];
}

export function isActiveFinding(finding: MaterialFinding): boolean {
  return ["new", "persisting", "accepted"].includes(finding.lifecycleState);
}

function evidenceText(finding: MaterialFinding): string {
  if (finding.evidence.length === 0) return "- No supporting evidence was recorded.";
  return finding.evidence
    .map((evidence) => {
      const detail = truncateUtf8(evidence.content.trim(), 2_000).content;
      return `- \`${evidence.id}\` (${evidence.type}): ${detail || "Recorded without text."}`;
    })
    .join("\n");
}

export function findingShortIdentity(finding: MaterialFinding): string {
  return `F-${createHash("sha256").update(finding.fingerprint.value).digest("hex").slice(0, 8)}`;
}

function reconciliationHint(finding: MaterialFinding): string {
  const normalized = [
    finding.location.path.trim().toLowerCase(),
    finding.location.line ?? "file",
    finding.summary.trim().toLowerCase().replaceAll(/\s+/g, " "),
  ].join("\n");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 20);
}

export function findingBody(finding: MaterialFinding): string {
  const limitations = finding.verificationState.limitations;
  const verification = [
    `**${finding.verificationState.type}** — ${finding.verificationState.explanation}`,
    ...(limitations.length === 0 ? [] : [`Limitations: ${limitations.join("; ")}`]),
  ].join("\n");
  return truncateUtf8(
    [
      findingIdentityMarker(finding.fingerprint.value),
      FINDING_COMMENT_MARKER,
      "",
      `**Finding ID:** \`${findingShortIdentity(finding)}\``,
      "",
      `**Problem:** ${finding.summary}`,
      "",
      `**Impact:** ${finding.impact}`,
      "",
      "**Evidence:**",
      evidenceText(finding),
      "",
      `**Verification state:** ${verification}`,
      "",
      `**Lifecycle state:** **${finding.lifecycleState}**`,
      "",
      "**Recommended next action:** Confirm the evidence, address the material problem, then rerun Diffowl. If context changes the assessment, reply with `/diffowl accept`, `/diffowl rebut <context>`, `/diffowl suppress <reason>`, `/diffowl ignore <reason>`, `/diffowl resolved`, `/diffowl recheck`, `/diffowl explain`, or `/diffowl reassess <context>`.",
      "",
      `Publication reconciliation hint (adapter-owned; not Finding identity): \`${reconciliationHint(finding)}\``,
    ].join("\n"),
    GITHUB_BODY_LIMIT,
  ).content;
}

function outcomeReason(outcome: ReviewOutcome): string | undefined {
  if ("reason" in outcome) return outcome.reason;
  if (outcome.type === "timeout")
    return `Review timed out after ${outcome.timeoutSeconds} seconds.`;
  return undefined;
}

function validationAttempts(outcome: ReviewOutcome): ValidationAttempt[] {
  return "verification" in outcome && outcome.verification !== undefined
    ? outcome.verification.validationAttempts
    : [];
}

function lifecycleCounts(findings: MaterialFinding[]): string {
  const counts = new Map<FindingLifecycleState, number>();
  for (const finding of findings) {
    counts.set(finding.lifecycleState, (counts.get(finding.lifecycleState) ?? 0) + 1);
  }
  return lifecycleOrder
    .filter((state) => counts.has(state))
    .map((state) => `${state}: ${counts.get(state)}`)
    .join(", ");
}

export function summaryBody(
  outcome: ReviewOutcome,
  unanchoredFindings: MaterialFinding[] = [],
  reviewUrl?: string,
): string {
  const findings = materialFindings(outcome);
  const attempts = validationAttempts(outcome);
  if (unanchoredFindings.length === 0) {
    unanchoredFindings = findings.filter((finding) => finding.location.line === undefined);
  }
  const lines = [
    SUMMARY_MARKER,
    "## Review OWL — current summary",
    "",
    `**Outcome:** \`${outcome.type}\``,
    `**Check conclusion:** \`${checkConclusion(outcome)}\``,
    `**Material Findings:** ${findings.length}${findings.length === 0 ? "" : ` (${lifecycleCounts(findings)})`}`,
    `**Validation attempts:** ${attempts.length}${attempts.length === 0 ? "" : ` (${attempts.map((attempt) => attempt.status).join(", ")})`}`,
  ];
  const reason = outcomeReason(outcome);
  if (reason !== undefined) lines.push(`**Coverage/details:** ${reason}`);
  if ("pullRequest" in outcome) lines.push(`**Reviewed head:** \`${outcome.pullRequest.headSha}\``);
  if (reviewUrl !== undefined) lines.push(`**Current finding threads:** ${reviewUrl}`);
  if (unanchoredFindings.length > 0) {
    lines.push("", "### Findings without a current inline anchor");
    for (const finding of unanchoredFindings) {
      lines.push(
        `- **${finding.summary}** — ${finding.impact} (\`${finding.location.path}\`, ${finding.lifecycleState}, ${finding.verificationState.type})`,
      );
    }
  }
  lines.push(
    "",
    "This comment is maintained in place and represents the current Review OWL state.",
  );
  return truncateUtf8(lines.join("\n"), GITHUB_BODY_LIMIT).content;
}

export function publishingSummaryBody(runMarker: string, headSha: string): string {
  return `${PUBLISHING_SUMMARY_MARKER} run=${runMarker} head=${headSha} -->\nReview OWL publication is in progress. This comment is not authoritative.`;
}

export function supersededSummaryBody(currentSummaryCommentId?: number): string {
  const destination =
    currentSummaryCommentId === undefined
      ? "A replacement publication is in progress."
      : `The current summary is #issuecomment-${currentSummaryCommentId}.`;
  return `${SUPERSEDED_SUMMARY_MARKER}\nThis Review OWL summary is not authoritative. ${destination}`;
}

export function supersededFindingBody(currentSummaryCommentId?: number): string {
  const destination =
    currentSummaryCommentId === undefined
      ? "A replacement publication is in progress."
      : `The current summary is #issuecomment-${currentSummaryCommentId}.`;
  return `${SUPERSEDED_FINDING_MARKER}\nThis Review OWL Finding thread is from a superseded publication and is not the current recommendation. ${destination}`;
}

function machineOutcome(outcome: ReviewOutcome): { json: string; complete: boolean } {
  const json = JSON.stringify(outcome);
  const wrapper = `Machine-readable Review outcome (complete):\n\n\`\`\`json\n${json}\n\`\`\``;
  if (Buffer.byteLength(wrapper) <= GITHUB_BODY_LIMIT) return { json, complete: true };
  return {
    json: JSON.stringify({
      type: outcome.type,
      ...("pullRequest" in outcome ? { pullRequest: outcome.pullRequest } : {}),
      complete: false,
      originalBytes: Buffer.byteLength(json),
      sha256: createHash("sha256").update(json).digest("hex"),
      truncation: "Full Review outcome exceeds the GitHub check output limit.",
    }),
    complete: false,
  };
}

export function jobSummaryBody(
  outcome: ReviewOutcome,
  publicationResult: string,
  reviewUrl?: string,
): string {
  const findings = materialFindings(outcome);
  const attempts = validationAttempts(outcome);
  const lines = [
    "## Diffowl Review readiness",
    "",
    `**Review readiness:** \`${checkConclusion(outcome)}\``,
    `**Review outcome:** \`${outcome.type}\``,
    `**Publication result:** \`${publicationResult}\``,
    `**Material Findings:** ${findings.length}${findings.length === 0 ? "" : ` (${lifecycleCounts(findings)})`}`,
    `**Verification count:** ${attempts.length}${attempts.length === 0 ? "" : ` (${attempts.map((attempt) => attempt.status).join(", ")})`}`,
  ];
  const reason = outcomeReason(outcome);
  if (reason !== undefined) lines.push(`**Coverage limits:** ${reason}`);
  if ("pullRequest" in outcome)
    lines.push(`**Reviewed revision:** \`${outcome.pullRequest.headSha}\``);
  if (reviewUrl !== undefined) lines.push(`**Pull-request review:** ${reviewUrl}`);
  lines.push("", "See the workflow logs for provider, validation, and publication details.");
  return lines.join("\n");
}

export function checkOutput(outcome: ReviewOutcome): {
  title: string;
  summary: string;
  text: string;
} {
  const findings = materialFindings(outcome);
  const machine = machineOutcome(outcome);
  return {
    title: `Review OWL: ${outcome.type}`,
    summary: `${findings.length} material Finding${findings.length === 1 ? "" : "s"}; conclusion ${checkConclusion(outcome)}.`,
    text: `Machine-readable Review outcome (${machine.complete ? "complete" : "bounded representation; full outcome truncated"}):\n\n\`\`\`json\n${machine.json}\n\`\`\``,
  };
}
