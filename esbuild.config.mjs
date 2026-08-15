import * as esbuild from "esbuild";
import { builtinModules } from "node:module";

const production = process.argv[2] === "production";

await esbuild.build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian owns the editor runtime. Bundling CodeMirror or Lezer creates a
  // second class identity and makes Obsidian reject our StateField/ViewPlugin
  // extensions when a Markdown editor opens.
  external: [
    "obsidian",
    "electron",
    "@electron/remote",
    "@codemirror/*",
    "@lezer/*",
    ...builtinModules
  ],
  format: "cjs",
  platform: "node",
  target: "es2022",
  logLevel: "info",
  sourcemap: production ? false : "inline",
  minify: production,
  treeShaking: true,
  outfile: "main.js"
});
