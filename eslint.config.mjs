import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

export default defineConfig([
  {
    ignores: [
      "node_modules/**",
      ".tmp/**",
      "main.js",
      "scripts/**",
      "tests/**",
      "*.mjs"
    ]
  },
  ...obsidianmd.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["Notability", "Notability Live Region", "Obsidian", "Markdown", "CodeMirror", "Electron", "Pandoc", "Word"],
          acronyms: ["PDF", "PNG", "SHA", "URL", "LRU", "DOM", "CSS", "DPR", "UI", "OCR", "HTML"]
        }
      ]
    }
  }
]);
