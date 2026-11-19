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
    // ADR 0011: money math goes through Dec. ADR 0013: the rule is
    // advisory — it warns here and gates nothing; the money-scan
    // workflow reports findings as a non-required check on PR diffs.
    files: ["packages/**/*.{ts,tsx}"],
    languageOptions: { parser: tseslint.parser },
    plugins: { cardex },
    rules: {
      "cardex/money-math": "warn",
    },
  },
  {
    // ADR 0016: telemetry writes are confined to usage.ts — the
    // no-personal-data boundary is a hard gate here, not an advisory.
    files: ["packages/mcp-worker/src/**/*.ts"],
    languageOptions: { parser: tseslint.parser },
    plugins: { cardex },
    rules: {
      "cardex/telemetry-sink": "error",
    },
  },
);
