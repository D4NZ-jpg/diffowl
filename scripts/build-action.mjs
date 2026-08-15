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
