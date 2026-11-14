// Local ESLint plugin — rules this repo wants that no published plugin has.
// Shared by eslint.config.mjs (pnpm lint, CI) and scripts/money-scan.mjs
// (the focused money audit the money-math skill and PR diffs run).

// ADR 0011: money moves through Dec (packages/mcp-worker/src/decimal.ts),
// never raw IEEE-754 arithmetic. The rule has two modes:
//
//   strict  — money modules (STRICT_FILES below) linted with
//             projectService: ask the TypeScript checker directly. A
//             *computed* number operand (any number-typed value that is
//             not a compile-time literal) inside arithmetic, rounding
//             calls, or a computed-vs-computed comparison is a finding.
//             Dec is exempt by type; literals (5 - 3, x > 0, cmp() < 0)
//             are folds and sign checks, not money math. Renaming a
//             variable cannot dodge it — this is the mode that proves
//             "in this file, money is never a raw number".
//
//   named   — everywhere else, and whenever no type info exists: an
//             identifier that looks like money inside the same
//             constructs is flagged instead. Most computed numbers in
//             ordinary files are counters and timestamps — the type
//             check alone cannot tell money from count (13/13 false
//             positives when tried repo-wide), so outside money
//             modules the name heuristic stays.
//
//   strictAll option — the advisory wide net. `pnpm money-scan
//   --strict-all` enables typed mode for every src file: findings are
//   triaged by the reviewer/agent, not gated on. Money findings get a
//   Dec fix or a STRICT_FILE promotion; noise gets a reasoned suppress
//   or an allowlist widening.
//
// Escape hatch either way: eslint-disable with a reason. Non-money
// number noise (timestamps, .length/.size, counters) is absorbed by a
// small allowlist plus suppression — the rule errs toward flagging.

const MONEY_NAME =
  /hkd|amount|spend|rebate|threshold|mile|\bcent|price|cost|fee|fx|\bcap\b|\brate\b|calculated|remaining|value|point/i;
// Modules where *every* computed-number arithmetic must go through Dec —
// the type check applies inside these files only. Add a path when a file
// owns money arithmetic; it should stay at zero findings.
const STRICT_FILE = /(?:^|\/)(?:query|scoring|money)\.ts$/;
// Matching glob list for ESLint configs that scope projectService to
// strict files only (scripts/money-scan.mjs) — keep in sync.
export const STRICT_GLOBS = ["packages/*/src/{query,scoring,money}.ts"];
const EXEMPT_FILE = /decimal\.ts$|\.test\.tsx?$/;
const EXEMPT_IDENT = /Dec$/;

const isMoneyName = (name) =>
  MONEY_NAME.test(name) && !EXEMPT_IDENT.test(name);

function collectNames(node, out) {
  if (!node || typeof node !== "object") return;
  if (node.type === "Identifier") {
    out.push(node.name);
    return;
  }
  for (const key of Object.keys(node)) {
    if (key === "parent" || key === "loc" || key === "range" || key === "type")
      continue;
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (child && typeof child === "object" && child.type)
          collectNames(child, out);
      }
    } else if (value && typeof value === "object" && value.type) {
      collectNames(value, out);
    }
  }
}

const hasMoneyName = (...nodes) => {
  const names = [];
  for (const n of nodes) collectNames(n, names);
  return names.some(isMoneyName);
};

// A `.length` / `.size` tail or a Date.*() call is counter/timestamp
// arithmetic, not money — exempt in both modes.
const isCountOrTime = (node) =>
  (node.type === "MemberExpression" &&
    !node.computed &&
    node.property.type === "Identifier" &&
    (node.property.name === "length" || node.property.name === "size")) ||
  (node.type === "CallExpression" &&
    node.callee.type === "MemberExpression" &&
    !node.callee.computed &&
    node.callee.object.type === "Identifier" &&
    node.callee.object.name === "Date");

const ROUNDING_MEMBERS = new Set(["round", "floor", "ceil", "trunc"]);

const moneyMathRule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "computed number values may not touch raw float arithmetic — exact math lives in Dec (packages/mcp-worker/src/decimal.ts), see ADR 0011",
    },
    messages: {
      floatMath:
        "raw float math on a number-typed value — exact math goes through Dec (packages/mcp-worker/src/decimal.ts), or eslint-disable with a reason if this is not money",
      floatMathNamed:
        "possible float math on money — move it through Dec (name exact values *Dec), or eslint-disable with a reason if this is not money",
    },
    schema: [
      {
        type: "object",
        properties: { strictAll: { type: "boolean" } },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    if (EXEMPT_FILE.test(filename)) return {};
    const strict =
      context.options?.[0]?.strictAll === true ||
      STRICT_FILE.test(filename);

    // Typed mode needs the program tseslint built for projectService.
    // Absent (site files, scans without the project loaded) → the name
    // heuristic still runs. TS6 dropped Type.isNumber() and renumbered
    // TypeFlags, so classify via getWidenedType + typeToString instead.
    const services = context.sourceCode?.parserServices;
    const checker =
      strict && services?.program ? services.program.getTypeChecker() : null;
    const toTsNode = services?.esTreeNodeToTSNodeMap ?? null;

    const isNumberish = (t) => {
      if (!t) return false;
      if (t.isUnion?.() || t.isIntersection?.())
        return t.types.some(isNumberish);
      const name = checker.typeToString(checker.getWidenedType(t));
      return name === "number" || name === "any";
    };
    const typeOf = (estNode) => {
      if (!checker || !toTsNode || isCountOrTime(estNode)) return null;
      const tsNode = toTsNode.get(estNode);
      return tsNode ? checker.getTypeAtLocation(tsNode) : null;
    };
    // Number-typed and not a compile-time literal constant — literal
    // types widen to a different type object, plain `number` does not.
    const isComputedNumber = (estNode) => {
      const t = typeOf(estNode);
      if (!isNumberish(t)) return false;
      if (t.isUnion?.() || t.isIntersection?.()) return true;
      return checker.getWidenedType(t) === t;
    };
    const anyComputed = (...nodes) => nodes.some(isComputedNumber);

    const report = (node) =>
      context.report({
        node,
        messageId: checker ? "floatMath" : "floatMathNamed",
      });

    return {
      BinaryExpression(node) {
        if ("+-*/%".includes(node.operator)) {
          if (
            anyComputed(node.left, node.right) ||
            (!checker && hasMoneyName(node.left, node.right))
          ) {
            report(node);
          }
        } else if (["<", "<=", ">", ">="].includes(node.operator)) {
          // Two computed numbers compared: a float sum can misjudge a
          // money boundary. Comparisons against literals (x > 0,
          // cmp() < 0) are sign checks, not money math.
          const computedPair =
            checker && isComputedNumber(node.left) && isComputedNumber(node.right);
          const namedPair =
            !checker &&
            !isCountOrTime(node.left) &&
            !isCountOrTime(node.right) &&
            hasMoneyName(node.left) &&
            hasMoneyName(node.right);
          if (computedPair || namedPair) report(node);
        }
      },
      AssignmentExpression(node) {
        if (!["+=", "-=", "*=", "/=", "%="].includes(node.operator)) return;
        if (
          anyComputed(node.left, node.right) ||
          (!checker && hasMoneyName(node.left, node.right))
        ) {
          report(node);
        }
      },
      UnaryExpression(node) {
        if (node.operator !== "-" && node.operator !== "+") return;
        if (
          isComputedNumber(node.argument) ||
          (!checker && hasMoneyName(node.argument))
        ) {
          report(node);
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        const prop = callee.property;
        const isRounding =
          (callee.object.type === "Identifier" &&
            callee.object.name === "Math" &&
            prop.type === "Identifier" &&
            ROUNDING_MEMBERS.has(prop.name)) ||
          (prop.type === "Identifier" &&
            (prop.name === "toFixed" || prop.name === "toPrecision"));
        if (!isRounding) return;
        const target =
          callee.object.type === "Identifier" && callee.object.name === "Math"
            ? node.arguments
            : [callee.object];
        if (anyComputed(...target) || (!checker && hasMoneyName(...target)))
          report(node);
      },
    };
  },
};

export default { rules: { "money-math": moneyMathRule } };
