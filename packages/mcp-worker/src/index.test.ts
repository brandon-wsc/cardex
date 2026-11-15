import {
  applyD1Migrations,
  createExecutionContext,
  env,
} from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { D1Migration } from "@cloudflare/vitest-plugin";
import worker from "./index";

// Wire-level specs for the auth and rate-limit layer in index.ts: bearer
// failure lockout, PIN attempt lockout, Access-configured header distrust,
// and same-origin enforcement on admin writes. Per test IP keeps the shared
// in-memory buckets independent.
const tenv = env as unknown as {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
  SEED_SQL: string;
};

beforeEach(async () => {
  await applyD1Migrations(tenv.DB, tenv.TEST_MIGRATIONS);
  const statements = tenv.SEED_SQL.split(";")
    .map((s) => s.trim())
    .filter(Boolean);
  await tenv.DB.batch(statements.map((sql) => tenv.DB.prepare(sql)));
});

const baseEnv = {
  DB: tenv.DB,
  MAINTAINER_TOKEN: "test-token",
  ADMIN_EMAIL: "owner@example.com",
  DEV_ADMIN_EMAIL: "owner@example.com",
  ASSETS: { fetch: () => Promise.resolve(new Response("asset")) },
};

function call(
  path: string,
  init?: RequestInit,
  over?: object,
  host = "cardex.test",
) {
  return worker.fetch(
    new Request(`https://${host}${path}`, init),
    { ...baseEnv, ...over } as unknown as Env,
    createExecutionContext(),
  );
}

const post = (body: unknown, headers?: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

describe("maintainer auth", () => {
  it("401s a bad bearer, passes a good one, and lockouts repeated failures", async () => {
    const ip = { "CF-Connecting-IP": "10.0.0.1" };
    const bad = await call("/maintainer", {
      headers: { ...ip, Authorization: "Bearer wrong" },
    });
    expect(bad.status).toBe(401);

    for (let i = 0; i < 10; i++) {
      await call("/maintainer", {
        headers: { ...ip, Authorization: `Bearer wrong${i}` },
      });
    }
    const locked = await call("/maintainer", {
      headers: { ...ip, Authorization: "Bearer test-token" },
    });
    expect(locked.status).toBe(429);

    const good = await call("/maintainer", {
      headers: {
        "CF-Connecting-IP": "10.0.0.2",
        Authorization: "Bearer test-token",
      },
    });
    expect([401, 429]).not.toContain(good.status);
  });

  it("404s the maintainer surface when MAINTAINER_TOKEN is unset", async () => {
    const res = await call("/maintainer", undefined, {
      MAINTAINER_TOKEN: undefined,
    });
    expect(res.status).toBe(404);
  });
});

describe("admin identity", () => {
  it("keeps report review behind admin identity", async () => {
    const noIdentity = await call("/admin/api/reports", undefined, {
      DEV_ADMIN_EMAIL: undefined,
    });
    expect(noIdentity.status).toBe(401);

    const owner = await call(
      "/admin/api/reports",
      { headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" } },
      { DEV_ADMIN_EMAIL: undefined },
      "localhost",
    );
    expect(owner.status).toBe(200);
    const body = await owner.json() as { reports: { id: string }[] };
    expect(body.reports.map((report) => report.id)).toContain("rpt_seed_001");
  });

  it("honors limit and offset on the reports list and returns its total", async () => {
    const page = await call(
      "/admin/api/reports?limit=1&offset=1",
      undefined,
      undefined,
      "localhost",
    );
    const body = (await page.json()) as {
      total: number;
      reports: unknown[];
    };
    expect(body.total).toBe(1);
    expect(body.reports).toHaveLength(0);
  });

  it("honors the before/before_id keyset cursor on the reports list", async () => {
    const page = await call(
      "/admin/api/reports" +
        "?before=2026-10-31T16%3A44%3A00Z&before_id=rpt_seed_001",
      undefined,
      undefined,
      "localhost",
    );
    const body = (await page.json()) as { reports: unknown[] };
    expect(body.reports).toHaveLength(0);
  });

  it("rejects a spoofed identity header off-localhost without the dev gate", async () => {
    const res = await call(
      "/admin/api/reports",
      { headers: { "Cf-Access-Authenticated-User-Email": "owner@example.com" } },
      { DEV_ADMIN_EMAIL: undefined },
    );
    expect(res.status).toBe(401);
  });

  it("does not mint an identity from DEV_ADMIN_EMAIL off-localhost", async () => {
    const res = await call("/admin/api/me");
    expect(res.status).toBe(401);
  });

  it("allows the dev identity on localhost without any flag", async () => {
    const res = await call(
      "/admin/api/me",
      undefined,
      undefined,
      "localhost",
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      email: "owner@example.com",
    });
  });

  it("allows the dev identity off-localhost when ALLOW_DEV_IDENTITY is set", async () => {
    const res = await call(
      "/admin/api/me",
      undefined,
      { ALLOW_DEV_IDENTITY: "true" },
    );
    expect(res.status).toBe(200);
  });

  it("rejects an authenticated identity that is not the owner", async () => {
    const res = await call("/admin/api/reports", {
      headers: {
        "CF-Connecting-IP": "10.0.0.10",
        "Cf-Access-Authenticated-User-Email": "intruder@example.com",
      },
    });
    expect(res.status).toBe(401);
  });

  it("401s the admin page itself without an identity", async () => {
    const res = await call("/admin", undefined, { DEV_ADMIN_EMAIL: undefined });
    expect(res.status).toBe(401);
  });

  it("ignores the identity header once ACCESS_AUD is configured", async () => {
    const res = await call(
      "/admin/api/me",
      {
        headers: {
          "CF-Connecting-IP": "10.0.0.3",
          "Cf-Access-Authenticated-User-Email": "owner@example.com",
        },
      },
      {
        ACCESS_TEAM: "cardex.cloudflareaccess.com",
        ACCESS_AUD: "aud-tag",
      },
    );
    expect(res.status).toBe(401);
  });
});

describe("admin api write checks", () => {
  it("rejects cross-site POSTs via fetch metadata or Origin", async () => {
    const ip = { "CF-Connecting-IP": "10.0.0.4" };
    for (const headers of [
      { ...ip, "Sec-Fetch-Site": "cross-site" },
      { ...ip, Origin: "https://evil.example" },
    ]) {
      const res = await call(
        "/admin/api/proposals/x/decide",
        post({ decision: "approve" }, headers),
        undefined,
        "localhost",
      );
      expect(res.status).toBe(403);
    }

    const sameOrigin = await call(
      "/admin/api/proposals/x/decide",
      post(
        { decision: "approve" },
        { ...ip, "Sec-Fetch-Site": "same-origin", Origin: "https://localhost" },
      ),
      undefined,
      "localhost",
    );
    expect(sameOrigin.status).not.toBe(403);
  });

  it("lockouts repeated bad PIN attempts when ADMIN_PIN is set", async () => {
    const ip = { "CF-Connecting-IP": "10.0.0.5" };
    for (let i = 0; i < 20; i++) {
      const res = await call(
        "/admin/api/proposals/x/decide",
        post({ decision: "approve", pin: "wrong" }, ip),
        { ADMIN_PIN: "1234" },
        "localhost",
      );
      expect(res.status).toBe(403);
    }
    const locked = await call(
      "/admin/api/proposals/x/decide",
      post({ decision: "approve", pin: "1234" }, ip),
      { ADMIN_PIN: "1234" },
      "localhost",
    );
    expect(locked.status).toBe(429);
  });

  it("rejects an unrecognized proposal decision", async () => {
    const res = await call(
      "/admin/api/proposals/prop_seed_001/decide",
      post({ decision: "maybe" }, { "CF-Connecting-IP": "10.0.0.11" }),
      undefined,
      "localhost",
    );
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({
      error: "invalid_decision",
    });
  });
});

// PRD §6: the per-IP budget applies to every surface — /mcp answers 429
// before the tool runs once the window is spent.
describe("public surface budget", () => {
  it("429s /mcp past the per-IP budget before the tool runs", async () => {
    const ip = { "CF-Connecting-IP": "10.0.0.20" };
    let last = 0;
    for (let i = 0; i < 121; i++) {
      const res = await call("/mcp", post({}, ip));
      last = res.status;
    }
    expect(last).toBe(429);
  });
});
