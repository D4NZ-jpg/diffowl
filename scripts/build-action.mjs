import { chmodSync } from "node:fs";
import { build } from "esbuild";

const shared = {
  bundle: true,
  minify: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  external: ["node-liblzma", "@mongodb-js/zstd"],
};

await Promise.all([
  build({ ...shared, entryPoints: ["src/action-entry.ts"], outfile: "dist/action/index.js" }),
  build({
    ...shared,
    entryPoints: ["src/review-request-entry.ts"],
    outfile: "review-request/dist/index.js",
  }),
]);

// npm sets the executable bit from the tarball mode, so the bin must be
// executable here or a symlinked install (node_modules/.bin) silently no-ops.
chmodSync("dist/cli.js", 0o755);
