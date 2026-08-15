/* oxlint-disable max-lines, max-lines-per-function */
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath, sep } from "node:path";
import { promisify } from "node:util";

import { PROJECT_POLICY_CEILINGS } from "./project-policy.js";
import type {
  ValidationExecutionRequest,
  ValidationAttempt,
  VerificationAdapter,
} from "./review-orchestration.js";
import type {
  SuggestedPatchValidationRequest,
  SuggestedPatchValidationResult,
} from "./suggested-patch.js";
import { decodeUtf8Prefix } from "./utf8.js";

const TERMINATION_GRACE_MS = 150;
const TERMINATION_RESOLVE_MS = 500;
const execFileAsync = promisify(execFile);

function boundedCollector(maxBytes: number): {
  append(chunk: Buffer): void;
  value(): string;
  truncated(): boolean;
} {
  const chunks: Buffer[] = [];
  let bytes = 0;
  let wasTruncated = false;
  return {
    append(chunk) {
      const remaining = maxBytes - bytes;
      if (remaining <= 0) {
        wasTruncated = true;
        return;
      }
      const kept = chunk.subarray(0, remaining);
      chunks.push(kept);
      bytes += kept.byteLength;
      if (kept.byteLength < chunk.byteLength) wasTruncated = true;
    },
    value: () => decodeUtf8Prefix(Buffer.concat(chunks)).content,
    truncated: () => wasTruncated,
  };
}

function boundedProcessOutput(maxBytes: number): {
  stdout: { append(chunk: Buffer): void; value(): string };
  stderr: { append(chunk: Buffer): void; value(): string };
  truncated(): boolean;
} {
  let remaining = maxBytes;
  let wasTruncated = false;
  const stream = () => {
    const chunks: Buffer[] = [];
    return {
      append(chunk: Buffer) {
        const kept = chunk.subarray(0, remaining);
        chunks.push(kept);
        remaining -= kept.byteLength;
        if (kept.byteLength < chunk.byteLength) wasTruncated = true;
      },
      value: () => decodeUtf8Prefix(Buffer.concat(chunks)).content,
    };
  };
  return { stdout: stream(), stderr: stream(), truncated: () => wasTruncated };
}

function commandEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    CI: "true",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    NO_COLOR: "1",
  };
  if (process.env.PATH !== undefined) env.PATH = process.env.PATH;
  if (process.env.SystemRoot !== undefined) env.SystemRoot = process.env.SystemRoot;
  return env;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      if (signal === "SIGKILL") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          env: commandEnvironment(),
          stdio: "ignore",
          windowsHide: true,
        }).unref();
      } else {
        child.kill(signal);
      }
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    child.kill(signal);
  }
}

// Process lifecycle handling stays together so timeout, abort, and escalation cannot diverge.
export function executeArgvCommand(
  request: ValidationExecutionRequest,
): Promise<Omit<ValidationAttempt, "commandIndex" | "argv" | "timeoutSeconds">> {
  return new Promise((resolve) => {
    const [command, ...args] = request.argv;
    if (command === undefined) {
      resolve({
        status: "error",
        stdout: "",
        stderr: "",
        truncated: false,
        limitation: "Validation command argv was empty.",
      });
      return;
    }
    const output = boundedProcessOutput(request.maxOutputBytes);
    let timedOut = false;
    let aborted = request.signal.aborted;
    let spawnError: Error | undefined;
    let settled = false;
    let escalation: NodeJS.Timeout | undefined;
    let forcedResolution: NodeJS.Timeout | undefined;
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: commandEnvironment(),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (chunk: Buffer) => output.stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => output.stderr.append(chunk));
    child.on("error", (error) => {
      spawnError = error;
    });
    const finish = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (escalation !== undefined) clearTimeout(escalation);
      if (forcedResolution !== undefined) clearTimeout(forcedResolution);
      request.signal.removeEventListener("abort", abort);
      const status = aborted
        ? "aborted"
        : timedOut
          ? "timed_out"
          : spawnError !== undefined
            ? "error"
            : exitCode === 0
              ? "passed"
              : "failed";
      resolve({
        status,
        ...(exitCode === null ? {} : { exitCode }),
        stdout: output.stdout.value(),
        stderr: output.stderr.value(),
        truncated: output.truncated(),
        ...(spawnError === undefined ? {} : { limitation: spawnError.message }),
      });
    };
    const terminate = () => {
      signalProcessTree(child, "SIGTERM");
      escalation ??= setTimeout(() => signalProcessTree(child, "SIGKILL"), TERMINATION_GRACE_MS);
      forcedResolution ??= setTimeout(() => {
        child.stdout.destroy();
        child.stderr.destroy();
        child.unref();
        finish(null);
      }, TERMINATION_RESOLVE_MS);
    };
    const abort = () => {
      aborted = true;
      terminate();
    };
    request.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, request.timeoutSeconds * 1_000);
    child.on("close", finish);
    if (aborted) terminate();
  });
}

export const readGitFileAtHead: VerificationAdapter["readRepositoryFile"] = (request) =>
  new Promise((resolve, reject) => {
    if (request.signal.aborted) {
      reject(new Error("Repository evidence read was aborted."));
      return;
    }
    const child = spawn("git", ["show", `${request.headSha}:${request.path}`], {
      cwd: process.cwd(),
      env: commandEnvironment(),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = boundedCollector(request.maxBytes);
    const errors = boundedCollector(request.maxBytes);
    child.stdout.on("data", (chunk: Buffer) => output.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => errors.append(chunk));
    const abort = () => signalProcessTree(child, "SIGTERM");
    request.signal.addEventListener("abort", abort, { once: true });
    let spawnError: Error | undefined;
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (exitCode) => {
      request.signal.removeEventListener("abort", abort);
      if (request.signal.aborted) {
        reject(new Error("Repository evidence read was aborted."));
      } else if (spawnError !== undefined) {
        reject(spawnError);
      } else if (exitCode === 0) {
        resolve({ content: output.value(), truncated: output.truncated() });
      } else if (errors.value().includes("does not exist in")) {
        resolve(undefined);
      } else {
        reject(new Error(errors.value() || `git show exited with code ${exitCode ?? "unknown"}.`));
      }
    });
  });

interface ContainerPatchFileStat {
  size: number;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export interface ContainerPatchValidationPrimitives {
  createWorkspace(): Promise<string>;
  checkoutExactHead(
    workspace: string,
    headSha: string,
    maxBytes: number,
    signal: AbortSignal,
  ): Promise<void>;
  readWorkspaceFile(path: string): Promise<string>;
  writePatchedFile(path: string, contents: string): Promise<void>;
  statWorkspaceFile(path: string): Promise<ContainerPatchFileStat>;
  runContainer(request: ValidationExecutionRequest): Promise<SuggestedPatchValidationResult>;
  cleanup(workspace: string, checkedOut: boolean): Promise<void>;
}

function workspacePath(workspace: string, path: string): string | undefined {
  const root = resolvePath(workspace);
  const target = resolvePath(root, path);
  return target.startsWith(`${root}${sep}`) ? target : undefined;
}

function normalizedPatchSource(
  contents: string,
): { text: string; newline: "\n" | "\r\n" } | undefined {
  if (contents.includes("\0") || contents.includes("�")) return undefined;
  const withoutCrLf = contents.replaceAll("\r\n", "");
  if (withoutCrLf.includes("\r")) return undefined;
  const usesCrLf = contents.includes("\r\n");
  if (usesCrLf && withoutCrLf.includes("\n")) return undefined;
  return {
    text: usesCrLf ? contents.replaceAll("\r\n", "\n") : contents,
    newline: usesCrLf ? "\r\n" : "\n",
  };
}

function patchedContents(
  contents: string,
  request: SuggestedPatchValidationRequest,
): string | undefined {
  const source = normalizedPatchSource(contents);
  if (source === undefined) return undefined;
  const finalNewline = source.text.endsWith("\n");
  const lines = source.text.split("\n");
  if (finalNewline) lines.pop();
  const selected = lines.slice(request.startLine - 1, request.endLine).join("\n");
  if (selected !== request.expected || request.endLine > lines.length) return undefined;
  const replacement = request.replacement.length === 0 ? [] : request.replacement.split("\n");
  lines.splice(request.startLine - 1, request.endLine - request.startLine + 1, ...replacement);
  return `${lines.join(source.newline)}${finalNewline ? source.newline : ""}`;
}

function dockerArgv(
  request: SuggestedPatchValidationRequest,
  workspace: string,
  patchedFile: string,
): string[] {
  const [command, ...args] = request.command.argv;
  const user = `${process.getuid?.() ?? 65_534}:${process.getgid?.() ?? 65_534}`;
  return [
    "docker",
    "run",
    "--rm",
    "--pull",
    "never",
    "--cidfile",
    `${workspace}.cid`,
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--memory",
    String(request.security.memoryBytes),
    "--cpus",
    String(request.security.cpuCount),
    "--pids-limit",
    String(request.security.processLimit),
    "--user",
    user,
    "--tmpfs",
    `/tmp:rw,noexec,nosuid,nodev,size=${request.security.temporaryBytes}`,
    "--mount",
    `type=bind,src=${workspace},dst=/workspace,readonly`,
    "--mount",
    `type=bind,src=${patchedFile},dst=/workspace/${request.path},readonly`,
    "--workdir",
    "/workspace",
    "--entrypoint",
    "/usr/bin/env",
    request.sandboxImage,
    "-i",
    "CI=true",
    "NO_COLOR=1",
    "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    command!,
    ...args,
  ];
}

function isMissingContainer(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : "";
  return /no such (?:container|object)/iu.test(detail);
}

async function removeValidationContainer(workspace: string): Promise<void> {
  let containerId = "";
  try {
    containerId = (await readFile(`${workspace}.cid`, "utf8")).trim();
  } catch {
    return;
  }
  if (containerId === "") return;
  try {
    await execFileAsync("docker", ["rm", "--force", containerId], {
      env: commandEnvironment(),
      timeout: 10_000,
    });
  } catch (removalError) {
    try {
      await execFileAsync("docker", ["inspect", containerId], {
        env: commandEnvironment(),
        timeout: 10_000,
      });
      throw new Error("The Suggested patch validation container was not removed.", {
        cause: removalError,
      });
    } catch (inspectionError) {
      if (isMissingContainer(inspectionError)) return;
      throw removalError;
    }
  }
}

const defaultContainerPatchPrimitives: ContainerPatchValidationPrimitives = {
  createWorkspace: () => mkdtemp(join(tmpdir(), "diffowl-patch-")),
  checkoutExactHead: async (workspace, headSha, maxBytes, signal) => {
    const options = {
      cwd: process.cwd(),
      env: commandEnvironment(),
      encoding: "utf8" as const,
      maxBuffer: 4 * 1024 * 1024,
      signal,
      timeout: 60_000,
    };
    const tree = await execFileAsync("git", ["ls-tree", "-rl", headSha], options);
    const bytes = tree.stdout.split("\n").reduce((total, entry) => {
      const size = /^\d+\s+blob\s+[\da-f]+\s+(\d+)\t/u.exec(entry)?.[1];
      return total + (size === undefined ? 0 : Number(size) + 8 * 1024);
    }, 0);
    if (!Number.isSafeInteger(bytes) || bytes > maxBytes) {
      throw new Error("The exact reviewed revision exceeds the Suggested patch workspace bound.");
    }
    await execFileAsync("git", ["worktree", "add", "--detach", workspace, headSha], options);
  },
  readWorkspaceFile: (path) => readFile(path, "utf8"),
  writePatchedFile: (path, contents) => writeFile(path, contents, { encoding: "utf8", flag: "wx" }),
  statWorkspaceFile: (path) => lstat(path),
  runContainer: executeArgvCommand,
  cleanup: async (workspace, checkedOut) => {
    let cleanupError: unknown;
    try {
      await removeValidationContainer(workspace);
    } catch (error) {
      cleanupError = error;
    }
    if (checkedOut) {
      try {
        await execFileAsync("git", ["worktree", "remove", "--force", workspace], {
          cwd: process.cwd(),
          env: commandEnvironment(),
          timeout: 30_000,
        });
      } catch {
        // The final recursive removal still destroys the disposable workspace.
      }
    }
    await Promise.all([
      rm(workspace, { recursive: true, force: true }),
      rm(`${workspace}.patched`, { force: true }),
      rm(`${workspace}.cid`, { force: true }),
    ]);
    if (cleanupError !== undefined) throw cleanupError;
  },
};

export function createContainerSuggestedPatchValidator(
  primitives: ContainerPatchValidationPrimitives = defaultContainerPatchPrimitives,
): NonNullable<VerificationAdapter["validateSuggestedPatch"]> {
  return async (request) => {
    let workspace = "";
    let checkedOut = false;
    try {
      workspace = await primitives.createWorkspace();
      await primitives.checkoutExactHead(
        workspace,
        request.headSha,
        request.security.temporaryBytes,
        request.signal,
      );
      checkedOut = true;
      const sourceFile = workspacePath(workspace, request.path);
      if (sourceFile === undefined) {
        return {
          status: "stale",
          stdout: "",
          stderr: "",
          truncated: false,
          limitation: "The Suggested patch path escaped the exact-head workspace.",
        };
      }
      const stat = await primitives.statWorkspaceFile(sourceFile);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.size > PROJECT_POLICY_CEILINGS.repositoryEvidenceBytes
      ) {
        return {
          status: "unavailable",
          stdout: "",
          stderr: "",
          truncated: false,
          limitation: "The Suggested patch target is not a regular text file.",
        };
      }
      const contents = await primitives.readWorkspaceFile(sourceFile);
      const patched = patchedContents(contents, request);
      if (patched === undefined) {
        return {
          status: "stale",
          stdout: "",
          stderr: "",
          truncated: false,
          limitation: "The Suggested patch does not apply to the exact reviewed revision.",
        };
      }
      const patchedFile = `${workspace}.patched`;
      await primitives.writePatchedFile(patchedFile, patched);
      return await primitives.runContainer({
        argv: dockerArgv(request, workspace, patchedFile),
        timeoutSeconds: request.command.timeoutSeconds,
        maxOutputBytes: PROJECT_POLICY_CEILINGS.validationOutputBytes,
        signal: request.signal,
      });
    } catch (error) {
      return {
        status: request.signal.aborted ? "aborted" : "unavailable",
        stdout: "",
        stderr: "",
        truncated: false,
        limitation: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (workspace !== "") await primitives.cleanup(workspace, checkedOut);
    }
  };
}

export function createHostVerificationAdapter(
  readExactHeadFile: VerificationAdapter["readRepositoryFile"] = readGitFileAtHead,
  validateSuggestedPatch: NonNullable<
    VerificationAdapter["validateSuggestedPatch"]
  > = createContainerSuggestedPatchValidator(),
): VerificationAdapter {
  return {
    readRepositoryFile: readExactHeadFile,
    executeValidation: executeArgvCommand,
    validateSuggestedPatch,
  };
}
