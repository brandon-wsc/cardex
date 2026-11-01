import tsParser from "@typescript-eslint/parser";

// Complexity gate only — no stylistic rules, no formatter duties.
export default [
  {
    files: ["packages/mcp-worker/src/**/*.ts"],
    languageOptions: { parser: tsParser },
    rules: {
      complexity: ["error", { max: 12, variant: "modified" }],
    },
  },
];
