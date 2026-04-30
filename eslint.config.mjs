// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  ...obsidianmd.configs.recommended,

  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tsparser,
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },

    // Optional project overrides
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["YourBrand"],
          acronyms: ["OK", "ID", "URL", "PIN"],
          enforceCamelCaseLower: true,
        },
      ],
    },
  },

  {
    ignores: [
      "node_modules",
      "dist",
      "esbuild.config.mjs",
      "eslint.config.js",
      "version-bump.mjs",
      "versions.json",
      "main.js",
    ],
  }
]);
