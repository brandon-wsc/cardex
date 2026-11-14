import tseslint from "typescript-eslint";
import cardex from "./scripts/eslint-local-rules.mjs";

// Bug-pattern gate only — no stylistic rules, no formatter duties.
export default tseslint.config(
  {
    // Generated declarations and vendored trees are not reviewed code.
    ignores: ["**/*.d.ts", "**/dist/**", "**/node_modules/**"],
  },
  {
    files: ["packages/mcp-worker/src/**/*.ts"],
    rules: {
      complexity: ["error", { max: 12, variant: "modified" }],
    },
  },
  {
    files: ["packages/mcp-worker/src/**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true },
    },
    plugins: { "@typescript-eslint": tseslint.plugin },
    rules: {
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/require-await": "error",
    },
  },
  {
    // ADR 0011: money math goes through Dec — the rule is name-based and
    // also runs standalone via `pnpm money-scan` (CI diffs).
    files: ["packages/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { cardex },
    rules: {
      "cardex/money-math": "error",
    },
  },
);
