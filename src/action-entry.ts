import { runAction } from "./action.js";
import { actionExitCodeForOutcome } from "./action-readiness.js";

try {
  const outcome = await runAction(process.env);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
  process.exitCode = actionExitCodeForOutcome(outcome);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Review OWL failed: ${message}\n`);
  process.exitCode = 1;
}
