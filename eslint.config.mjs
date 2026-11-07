import tseslint from "typescript-eslint";

// Bug-pattern gate only — no stylistic rules, no formatter duties.
export default tseslint.config(
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
);
