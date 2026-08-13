import { build } from "esbuild";

await build({
  entryPoints: ["src/action-entry.ts"],
  outfile: "dist/action/index.js",
  bundle: true,
  minify: true,
  platform: "node",
  target: "node24",
  format: "esm",
  banner: {
    js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
  },
  external: ["node-liblzma", "@mongodb-js/zstd"],
});
