import { createMcpHandler } from "agents/mcp/server";

import { accessIdentity } from "./access.js";
import { overLimit, rateLimited } from "./ratelimit.js";
import {
  decideProposal,
  getProposal,
  listProposals,
  listReports,
} from "./maintain.js";
import { buildMaintainerServer } from "./maintainer-server.js";
import { buildServer } from "./server.js";

// These four live in .dev.vars locally and are `wrangler secret put` in
// prod, so generated Env types only see them when .dev.vars exists (CI has
// none). Declared here as non-optional so the interface merge stays
// identical whether or not wrangler emitted them; runtime guards below
// handle actual absence.
declare global {
  // workerd implements timingSafeEqual but the shared SubtleCrypto lib type
  // lacks it — merge the extension here so the secret compares typecheck.
  interface SubtleCrypto {
    timingSafeEqual(
      a: ArrayBuffer | ArrayBufferView,
      b: ArrayBuffer | ArrayBufferView,
    ): boolean;
  }
  interface Env {
    MAINTAINER_TOKEN: string;
    ADMIN_EMAIL: string;
    DEV_ADMIN_EMAIL: string;
    ALLOW_DEV_IDENTITY: string;
    ADMIN_PIN: string;
    ACCESS_TEAM: string;
    ACCESS_AUD: string;
  }
}

const json = (body: unknown, status = 200) =>
  Response.json(body, { status });

// Constant-time compare for the two shared secrets — a plain !== leaks
// prefix length through timing.
function secretEqual(a: string | null, b: string): boolean {
  if (!a) return false;
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  if (x.byteLength !== y.byteLength) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

const clientIp = (request: Request) =>
  request.headers.get("CF-Connecting-IP") ?? "anonymous";

const RATE = {
  mcp: { limit: 120, windowMs: 60_000 },
  maintainerAuth: { limit: 10, windowMs: 3_600_000 },
  adminApi: { limit: 120, windowMs: 60_000 },
  pin: { limit: 20, windowMs: 3_600_000 },
};

// Non-GET admin API calls must come from the portal itself: fetch metadata
// and Origin both name a same-origin caller (non-browser clients send
// neither and stay allowed — auth still applies). Per-IP budget on top.
function adminApiRequestGuard(
  request: Request,
  url: URL,
  ip: string,
): Response | null {
  if (rateLimited(`admin:${ip}`, RATE.adminApi.limit, RATE.adminApi.windowMs))
    return new Response("Too many requests", { status: 429 });
  if (request.method === "GET" || request.method === "HEAD") return null;
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "same-site")
    return json({ error: "forbidden" }, 403);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin)
    return json({ error: "forbidden" }, 403);
  return null;
}

// The real boundary is the Cloudflare Access app in front of /admin (email
// OTP, owner only). When ACCESS_TEAM + ACCESS_AUD are configured the signed
// Cf-Access-Jwt-Assertion is verified and is the only identity source.
//
// Without those secrets the header/DEV_ADMIN_EMAIL fallback must not mint
// an identity on a routable hostname: Cf-Access-Authenticated-User-Email is
// only trustworthy when Access injected it, and the Worker cannot tell a
// request that bypassed the app. The fallback therefore fires only on
// loopback hostnames (local `wrangler dev`) or behind ALLOW_DEV_IDENTITY,
// an explicit opt-in for non-local dev setups — never in production.
const DEV_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function devIdentityAllowed(request: Request, env: Env): boolean {
  if (env.ALLOW_DEV_IDENTITY === "true") return true;
  const host = new URL(request.url).hostname;
  return DEV_HOSTS.has(host) || host.endsWith(".localhost");
}

async function adminIdentity(
  request: Request,
  env: Env,
): Promise<string | null> {
  const email =
    env.ACCESS_TEAM && env.ACCESS_AUD
      ? await accessIdentity(request, env)
      : devIdentityAllowed(request, env)
        ? (request.headers.get("Cf-Access-Authenticated-User-Email") ??
          env.DEV_ADMIN_EMAIL ??
          null)
        : null;
  if (!email) return null;
  if (env.ADMIN_EMAIL && email !== env.ADMIN_EMAIL) return null;
  return email;
}

async function handleProposalDecide(
  request: Request,
  env: Env,
  email: string,
  proposalId: string,
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    decision?: string;
    note?: string;
    pin?: string;
  };
  const pinKey = `pin:${clientIp(request)}`;
  if (env.ADMIN_PIN && overLimit(pinKey, RATE.pin.limit)) {
    return json({ ok: false, error: "rate_limited" }, 429);
  }
  if (env.ADMIN_PIN && !secretEqual(body.pin ?? null, env.ADMIN_PIN)) {
    rateLimited(pinKey, RATE.pin.limit, RATE.pin.windowMs);
    return json({ ok: false, error: "bad_pin" }, 403);
  }
  if (body.decision !== "approve" && body.decision !== "reject") {
    return json({ ok: false, error: "invalid_decision" }, 400);
  }
  const res = await decideProposal(env.DB, proposalId, {
    decision: body.decision,
    decided_by: email,
    note: body.note,
  });
  return json(res, res.ok ? 200 : 400);
}

async function handleProposalRoutes(
  request: Request,
  env: Env,
  url: URL,
  email: string,
  path: string,
): Promise<Response> {
  if (path === "/proposals" && request.method === "GET") {
    return json(
      await listProposals(env.DB, {
        status: url.searchParams.get("status") ?? undefined,
      }),
    );
  }

  const decideMatch = path.match(/^\/proposals\/([^/]+)\/decide$/);
  if (decideMatch && request.method === "POST") {
    return handleProposalDecide(request, env, email, decideMatch[1]);
  }

  const getMatch = path.match(/^\/proposals\/([^/]+)$/);
  if (getMatch && request.method === "GET") {
    const res = await getProposal(env.DB, getMatch[1]);
    return json(res, res.ok ? 200 : 404);
  }

  return json({ ok: false, error: "not_found" }, 404);
}

async function handleAdminApi(
  request: Request,
  env: Env,
  url: URL,
  email: string,
): Promise<Response> {
  const path = url.pathname.slice("/admin/api".length);

  if (path === "/me" && request.method === "GET") {
    return json({ email, pin_required: !!env.ADMIN_PIN });
  }
  if (path === "/reports" && request.method === "GET") {
    const num = (key: string) => {
      const raw = url.searchParams.get(key);
      if (raw === null) return undefined;
      const n = Number(raw);
      return Number.isFinite(n) ? n : undefined;
    };
    return json(
      await listReports(env.DB, {
        limit: num("limit"),
        offset: num("offset"),
        before: url.searchParams.get("before") ?? undefined,
        beforeId: url.searchParams.get("before_id") ?? undefined,
      }),
    );
  }
  if (path.startsWith("/proposals")) {
    return handleProposalRoutes(request, env, url, email, path);
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      if (
        rateLimited(`mcp:${clientIp(request)}`, RATE.mcp.limit, RATE.mcp.windowMs)
      ) {
        return new Response("Too many requests", { status: 429 });
      }
      const mcp = createMcpHandler(() => buildServer(env.DB), {
        route: "/mcp",
      });
      return mcp(request, env, ctx);
    }

    if (url.pathname === "/maintainer") {
      if (!env.MAINTAINER_TOKEN) {
        return new Response("Not found", { status: 404 });
      }
      const authKey = `maint-auth:${clientIp(request)}`;
      if (overLimit(authKey, RATE.maintainerAuth.limit)) {
        return new Response("Too many requests", { status: 429 });
      }
      if (
        !secretEqual(
          request.headers.get("Authorization"),
          `Bearer ${env.MAINTAINER_TOKEN}`,
        )
      ) {
        rateLimited(
          authKey,
          RATE.maintainerAuth.limit,
          RATE.maintainerAuth.windowMs,
        );
        return json({ error: "unauthorized" }, 401);
      }
      const mcp = createMcpHandler(() => buildMaintainerServer(env.DB), {
        route: "/maintainer",
      });
      return mcp(request, env, ctx);
    }

    if (["/admin", "/admin/", "/admin.html"].includes(url.pathname)) {
      if (!(await adminIdentity(request, env))) {
        return new Response("Unauthorized", { status: 401 });
      }
      return env.ASSETS.fetch(new URL("/admin", url));
    }

    if (url.pathname.startsWith("/admin/api/")) {
      const email = await adminIdentity(request, env);
      if (!email) {
        return json({ error: "unauthorized" }, 401);
      }
      const guard = adminApiRequestGuard(
        request,
        url,
        clientIp(request),
      );
      if (guard) return guard;
      return handleAdminApi(request, env, url, email);
    }

    // Only paths no static asset matched reach here; the assets layer
    // answers with the site's 404 page.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
