import type {
  RoleExecutionArtifact,
  RoleExecutionRequest,
  RoleExecutionResult,
} from "../src/review-engine.js";

export function emptyArtifact(role: RoleExecutionRequest["step"]["role"]): RoleExecutionArtifact {
  return {
    role,
    snapshot: { version: 1, files: [] },
    events: [],
    files: [],
    sessionId: `${role}-session`,
    finishReason: "stop",
  };
}

export function emptyRoleResult(request: RoleExecutionRequest): RoleExecutionResult {
  const role = request.step.role;
  const output =
    role === "reviewer"
      ? { role, candidateFindings: [], advisorySuggestions: [] }
      : { role, assessments: [] };
  return { type: "completed", output, artifact: emptyArtifact(role) };
}
