import { build } from "esbuild";

await build({
  entryPoints: ["src/action-entry.ts"],
  outfile: "dist/action/index.js",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
});
