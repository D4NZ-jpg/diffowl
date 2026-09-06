import { createActionIo, runAction } from "./action.js";
import { actionExitCodeForOutcome } from "./action-readiness.js";

const io = createActionIo(process.env);
try {
  const outcome = await runAction(process.env, io);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exitCode = actionExitCodeForOutcome(outcome);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Review OWL failed: ${message}\n`);
  process.exitCode = 1;
} finally {
  await io.close?.();
}
