import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Benchmark checkouts under scripts/benchmark/checkouts contain their own test suites.
    exclude: ["**/node_modules/**", "scripts/benchmark/**"],
  },
});
