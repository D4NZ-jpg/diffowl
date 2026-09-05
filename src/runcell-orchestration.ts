import {
  createAgent,
  createSandbox,
  createVirtualSandbox,
  type AgentEvents,
  type AgentOptions,
  type AgentSchema,
  type ChangedFile,
  type FileInput,
  type RunResult,
  type Sandbox,
} from "runcell";
import { z } from "zod";

import type {
  RoleExecutionArtifact,
  RoleExecutionEvent,
  RoleExecutionRequest,
  RoleExecutionResult,
  RoleOutput,
  RoleWorkspace,
} from "./review-orchestration.js";
import type { ReviewRole } from "./project-policy.js";

const locationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  line: z.number().int().positive().optional(),
});

const candidateSchema = z.object({
  summary: z.string().min(1),
  location: locationSchema,
  impact: z.string().min(1),
  evidence: z.array(z.string().min(1)).min(1),
  fingerprintContext: z
    .object({
      claimKind: z.string().min(1).optional(),
      affectedArea: z.string().min(1).optional(),
      policyOrCapability: z.string().min(1).optional(),
      symbol: z.string().min(1).optional(),
      api: z.string().min(1).optional(),
      configKey: z.string().min(1).optional(),
      behavior: z.string().min(1).optional(),
    })
    .optional(),
  suggestedPatch: z
    .object({
      startLine: z.number().int().positive(),
      endLine: z.number().int().positive(),
      replacement: z.string(),
    })
    .optional(),
});

const advisorySchema = z.object({
  summary: z.string().min(1),
  rationale: z.string().min(1),
  location: locationSchema.optional(),
});

const reviewerOutputSchema = z.object({
  candidateFindings: z.array(candidateSchema),
  advisorySuggestions: z.array(advisorySchema),
});

const challengerOutputSchema = z.object({
  assessments: z.array(
    z.object({
      candidateIndex: z.number().int().nonnegative(),
      verdict: z.enum(["support", "reject", "downgrade"]),
      reason: z.string().min(1),
    }),
  ),
});

const verifierOutputSchema = z.object({
  assessments: z.array(
    z.object({
      candidateIndex: z.number().int().nonnegative(),
      disposition: z.enum(["material", "advisory", "suppress", "abstain"]),
      evidenceIds: z.array(z.string().min(1)),
      explanation: z.string().min(1),
      limitations: z.array(z.string().min(1)),
    }),
  ),
});

type ReviewerOutput = z.infer<typeof reviewerOutputSchema>;
type ChallengerOutput = z.infer<typeof challengerOutputSchema>;
type VerifierOutput = z.infer<typeof verifierOutputSchema>;

export interface StructuredRoleRunOptions {
  prompt: string;
  files: FileInput[];
  schema: AgentSchema;
  sandbox: Sandbox;
  events: AgentEvents;
  signal: AbortSignal;
}

export interface RunCellRoleAgent {
  run(options: StructuredRoleRunOptions): Promise<RunResult<unknown>>;
}

export interface RunCellPrimitives {
  createAgent(options: AgentOptions): RunCellRoleAgent;
  createSandbox(workspace?: RoleWorkspace): Promise<Sandbox>;
}

/**
 * Context files are seeded under this directory so they never collide with
 * repository paths when a role runs inside a repository workspace.
 */
export const WORKSPACE_CONTEXT_DIRECTORY = ".diffowl";

const defaultPrimitives: RunCellPrimitives = {
  createAgent: (options) => createAgent(options) as RunCellRoleAgent,
  createSandbox: (workspace) =>
    workspace === undefined
      ? createVirtualSandbox()
      : createSandbox({
          type: "host",
          rootDir: workspace.rootDir,
          isolation: "external",
        }),
};

const workspacePromptSuffix =
  " The working directory is the repository checkout at the reviewed head revision; pull-request context files are under .diffowl/. Read repository files to ground your assessment. Do not modify repository files. Do not run commands other than reading files, except the verifier, which may only run the validation commands listed in the policy.";

const materialityRule =
  " Materiality rule: a defect is material when the change as written can produce incorrect behavior, a crash, a security or data-integrity problem, or a feature that silently does not work (for example a flag or gate that can never enable, a stub that always errors, a branch that is unreachable, a value that is validated twice while another is never validated). Material does not depend on guessed author intent, on whether the defect might be fixed later, or on how many users hit it; if the code is wrong, it is material. Advisory is only for style, naming, clarity, documentation, and speculative or unverifiable concerns.";

const rolePrompts: Record<ReviewRole, string> = {
  reviewer:
    "Generate structured candidate material findings and separate non-blocking advisory suggestions." +
    materialityRule +
    " Every defect that meets the materiality rule must be a candidate finding, never an advisory suggestion, even if you expect it to be argued down later. Cite only evidence available in the supplied pull-request context. For each candidate provide stable fingerprint context when known: claim kind, affected area, applicable policy or capability, and symbol/API/configuration/behavior location context. Never use line numbers or provider/thread identifiers as fingerprint context. A candidate may propose one contiguous Suggested patch replacement within its changed-line location; provide only startLine, endLine, and replacement. Never choose a file path, validation command, or proof.",
  challenger:
    "Challenge each candidate for false positives, weak evidence, and low materiality. Support, reject, or downgrade every candidate you can assess." +
    materialityRule +
    " Downgrade only when the candidate fails the materiality rule; do not downgrade a real defect because the author may have intended it or because a fix is easy.",
  verifier:
    "Verify the surviving candidates using only the engine-generated evidence catalog and validation attempts. Model agreement is not verification. Disposition each candidate as material, advisory, suppress, or abstain when evidence is insufficient to judge; cite catalog evidence IDs and state explicit limitations." +
    materialityRule +
    " Your job is to decide whether the claimed defect is real and shown by the evidence, not whether the author meant it: a confirmed defect is material even when the surrounding change suggests the feature is being removed or disabled, and even when a separate defect in the same change would also break the feature. Use suppress for claims the evidence refutes, advisory for claims that are true but fail the materiality rule, and abstain only when the evidence cannot settle the claim. Do not use limitations about missing validation commands as a reason to move a statically confirmed defect out of material.",
};

function runEvents(): {
  events: RoleExecutionEvent[];
  changedFiles: ChangedFile[];
  callbacks: AgentEvents;
} {
  const events: RoleExecutionEvent[] = [];
  const changedFiles: ChangedFile[] = [];
  const trace = process.env.DIFFOWL_DEBUG_PROVIDER === "1";
  return {
    events,
    changedFiles,
    callbacks: {
      onToolCall: (detail) => {
        if (trace) console.error(`[diffowl] tool_call ${JSON.stringify(detail).slice(0, 300)}`);
        events.push({ type: "tool_call", detail });
      },
      onToolResult: (detail) => {
        if (trace) console.error(`[diffowl] tool_result ${JSON.stringify(detail).slice(0, 200)}`);
        events.push({ type: "tool_result", detail });
      },
      onFileChange: (detail) => {
        changedFiles.push(detail);
        events.push({ type: "file_change", detail });
      },
      onRepair: (detail) => events.push({ type: "repair", detail }),
      onFinish: (detail) => events.push({ type: "finish", detail }),
      onError: (error) =>
        events.push({
          type: "error",
          detail: error instanceof Error ? error.message : error,
        }),
    },
  };
}

function contextFiles(request: RoleExecutionRequest): FileInput[] {
  const prefix = request.workspace === undefined ? "" : `${WORKSPACE_CONTEXT_DIRECTORY}/`;
  return [
    { path: `${prefix}pull-request.diff`, text: request.diff },
    {
      path: `${prefix}pull-request.json`,
      text: JSON.stringify(request.pullRequest, undefined, 2),
    },
    { path: `${prefix}role-input.json`, text: JSON.stringify(request.roleInput, undefined, 2) },
  ];
}

function rolePrompt(request: RoleExecutionRequest): string {
  const base = rolePrompts[request.step.role];
  return request.workspace === undefined ? base : `${base}${workspacePromptSuffix}`;
}

function roleSchema(request: RoleExecutionRequest): AgentSchema {
  if (request.step.role === "reviewer") return reviewerOutputSchema;
  return request.step.role === "challenger" ? challengerOutputSchema : verifierOutputSchema;
}

function roleOutput(role: ReviewRole, data: unknown): RoleOutput {
  if (role === "reviewer") return { role, ...(data as ReviewerOutput) };
  if (role === "challenger") return { role, ...(data as ChallengerOutput) };
  return { role, ...(data as VerifierOutput) };
}

async function executionArtifact(
  request: RoleExecutionRequest,
  sandbox: Sandbox,
  events: RoleExecutionEvent[],
  files: ChangedFile[],
  result?: RunResult<unknown>,
): Promise<RoleExecutionArtifact> {
  // A repository workspace is not snapshotted: it is the caller-owned checkout,
  // and serializing it would embed the whole repository in the outcome.
  const snapshot =
    request.workspace === undefined ? await sandbox.snapshot() : { version: 1 as const, files: [] };
  return {
    role: request.step.role,
    snapshot,
    events,
    files: result?.files ?? files,
    sessionId: result?.sessionId ?? "",
    finishReason: result?.finishReason ?? "error",
  };
}

export function createRunCellRoleExecutor(
  primitives: RunCellPrimitives = defaultPrimitives,
): (request: RoleExecutionRequest) => Promise<RoleExecutionResult> {
  return async (request) => {
    const sandbox = await primitives.createSandbox(request.workspace);
    const { events, changedFiles, callbacks } = runEvents();
    let result: RunResult<unknown> | undefined;
    const prompt = rolePrompt(request);
    try {
      const agent = primitives.createAgent({
        model: `${request.profile.provider}/${request.profile.model}`,
        credentials: request.credentials,
        systemPrompt: prompt,
      });
      result = await agent.run({
        prompt,
        files: contextFiles(request),
        schema: roleSchema(request),
        sandbox,
        events: callbacks,
        signal: request.signal,
      });
      const output = roleOutput(request.step.role, result.data);
      if (process.env.DIFFOWL_DEBUG_PROVIDER === "1") {
        console.error(`[diffowl] ${request.step.role} output ${JSON.stringify(output)}`);
      }
      const artifact = await executionArtifact(request, sandbox, events, changedFiles, result);
      if (
        output.role === "reviewer" &&
        output.candidateFindings.length > request.maxCandidateFindings
      ) {
        return {
          type: "budget_limit",
          reason: `Reviewer returned more than ${request.maxCandidateFindings} candidate findings.`,
          artifact,
        };
      }
      return { type: "completed", output, artifact };
    } catch (error) {
      if (process.env.DIFFOWL_DEBUG_PROVIDER === "1") {
        console.error(`[diffowl] ${request.step.role} role failed:`, error);
      }
      return {
        type: "provider_failure",
        reason: `Provider execution failed for the ${request.step.role} role.`,
        artifact: await executionArtifact(request, sandbox, events, changedFiles, result),
      };
    } finally {
      await sandbox.destroy();
    }
  };
}
