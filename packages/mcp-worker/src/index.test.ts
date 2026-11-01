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
  ASSETS: { fetch: async () => new Response("asset") },
};

function call(path: string, init?: RequestInit, over?: object) {
  return worker.fetch(
    new Request(`https://cardex.test${path}`, init),
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
});

describe("admin identity", () => {
  it("falls back to the dev identity when Access JWT is not configured", async () => {
    const res = await call("/admin/api/me");
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      email: "owner@example.com",
    });
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
      );
      expect(res.status).toBe(403);
    }

    const sameOrigin = await call(
      "/admin/api/proposals/x/decide",
      post(
        { decision: "approve" },
        { ...ip, "Sec-Fetch-Site": "same-origin", Origin: "https://cardex.test" },
      ),
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
      );
      expect(res.status).toBe(403);
    }
    const locked = await call(
      "/admin/api/proposals/x/decide",
      post({ decision: "approve", pin: "1234" }, ip),
      { ADMIN_PIN: "1234" },
    );
    expect(locked.status).toBe(429);
  });
});
