// eslint.config.mjs
import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import globals from "globals";

export default defineConfig([
  ...obsidianmd.configs.recommended,
  // Or include English locale files (JSON and TS/JS modules)
  // ...obsidianmd.configs.recommendedWithLocalesEn,

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
          acronyms: ["OK"],
          enforceCamelCaseLower: true,
        },
      ],
    },
  },
]);
