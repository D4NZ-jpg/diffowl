import { runAction } from "./action.js";

try {
  const outcome = await runAction(process.env);
  process.stdout.write(`${JSON.stringify(outcome)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`Review OWL failed: ${message}\n`);
  process.exitCode = 1;
}
