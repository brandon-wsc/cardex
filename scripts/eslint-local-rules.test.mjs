import { test } from "node:test";
import assert from "node:assert/strict";
import { ESLint } from "eslint";
import tseslint from "typescript-eslint";
import cardex, { STRICT_GLOBS } from "./eslint-local-rules.mjs";

const eslint = new ESLint({
  overrideConfigFile: true,
  baseConfig: [
    {
      ignores: ["**/*.d.ts", "**/node_modules/**", "**/dist/**"],
    },
    {
      files: ["**/*.{ts,tsx}"],
      languageOptions: { parser: tseslint.parser },
      plugins: { cardex },
      linterOptions: { reportUnusedDisableDirectives: "off" },
      rules: { "cardex/money-math": "error" },
    },
    {
      files: STRICT_GLOBS,
      languageOptions: {
        parserOptions: { projectService: true },
      },
    },
  ],
});

const STRICT_FILE = "packages/mcp-worker/src/query.ts";
const NAMED_FILE = "packages/site/src/lint-fixture.ts";

const lint = (code, filePath) =>
  eslint.lintText(code, { filePath }).then(([res]) => res.messages);

test("strict typed mode flags Math.min/Math.max on computed numbers", async () => {
  const messages = await lint(
    `const v = Number("1");
const c = Number("2");
export const lo = Math.min(v, c);
export const hi = Math.max(v, c);
export const r = Math.round(v);
`,
    STRICT_FILE,
  );
  assert.deepEqual(
    messages.map((m) => m.messageId),
    ["floatMath", "floatMath", "floatMath"],
  );
});

test("strict typed mode allows literal-only and non-Math min/max calls", async () => {
  const messages = await lint(
    `declare const d: { min(x: number): number; max(x: number): number };
const v = Number("1");
export const a = Math.min(1, 2);
export const b = Math.max(0, 100);
export const c = d.min(v);
export const e = d.max(v);
`,
    STRICT_FILE,
  );
  assert.deepEqual(messages, []);
});

test("named mode flags money-named Math.min/Math.max arguments", async () => {
  const messages = await lint(
    `const rebate = 1;
const cap = 2;
export const lo = Math.min(rebate, cap);
export const hi = Math.max(rebate, cap);
export const ok = Math.min(count, len);
`,
    NAMED_FILE,
  );
  assert.deepEqual(
    messages.map((m) => m.messageId),
    ["floatMathNamed", "floatMathNamed"],
  );
});
