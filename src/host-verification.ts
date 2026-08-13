/* oxlint-disable max-lines-per-function */
import { type ChildProcess, spawn } from "node:child_process";

import type {
  ValidationExecutionRequest,
  ValidationAttempt,
  VerificationAdapter,
} from "./review-orchestration.js";
import { decodeUtf8Prefix } from "./utf8.js";

const TERMINATION_GRACE_MS = 150;
const TERMINATION_RESOLVE_MS = 500;

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
  const env: NodeJS.ProcessEnv = { CI: "true", NO_COLOR: "1" };
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

export function createHostVerificationAdapter(
  readExactHeadFile: VerificationAdapter["readRepositoryFile"] = readGitFileAtHead,
): VerificationAdapter {
  return {
    readRepositoryFile: readExactHeadFile,
    executeValidation: executeArgvCommand,
  };
}
