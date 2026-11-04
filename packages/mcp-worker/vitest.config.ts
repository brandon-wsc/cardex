import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const migrations = await readD1Migrations(
  fileURLToPath(new URL("./migrations", import.meta.url)),
);
const seedSql = readFileSync(
  new URL("./test/seed.sql", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const cardexSkill = readFileSync(
  new URL("../../skills/cardex/SKILL.md", import.meta.url),
  "utf8",
);
const maintainerSkill = readFileSync(
  new URL("../../skills/cardex-maintainer/SKILL.md", import.meta.url),
  "utf8",
);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          SEED_SQL: seedSql,
          CARDEX_SKILL: cardexSkill,
          MAINTAINER_SKILL: maintainerSkill,
        },
      },
    }),
  ],
});
