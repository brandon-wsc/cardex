import { createMcpHandler } from "agents/mcp/server";

import { accessIdentity } from "./access.js";
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
  interface Env {
    MAINTAINER_TOKEN: string;
    ADMIN_EMAIL: string;
    DEV_ADMIN_EMAIL: string;
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

// The real boundary is the Cloudflare Access app in front of /admin (email
// OTP, owner only). When ACCESS_TEAM + ACCESS_AUD are configured the signed
// Cf-Access-Jwt-Assertion is verified and is the only identity source —
// the header path (and DEV_ADMIN_EMAIL) is off. Otherwise this falls back
// to the verified identity header as a second layer and enforces the owner
// address. DEV_ADMIN_EMAIL exists so local `wrangler dev` can exercise the
// portal without Access; it stays unset in production.
async function adminIdentity(
  request: Request,
  env: Env,
): Promise<string | null> {
  const email =
    env.ACCESS_TEAM && env.ACCESS_AUD
      ? await accessIdentity(request, env)
      : (request.headers.get("Cf-Access-Authenticated-User-Email") ??
        env.DEV_ADMIN_EMAIL ??
        null);
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
  if (env.ADMIN_PIN && !secretEqual(body.pin ?? null, env.ADMIN_PIN)) {
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
    return json(await listReports(env.DB, {}));
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
      const mcp = createMcpHandler(() => buildServer(env.DB), {
        route: "/mcp",
      });
      return mcp(request, env, ctx);
    }

    if (url.pathname === "/maintainer") {
      if (!env.MAINTAINER_TOKEN) {
        return new Response("Not found", { status: 404 });
      }
      if (
        !secretEqual(
          request.headers.get("Authorization"),
          `Bearer ${env.MAINTAINER_TOKEN}`,
        )
      ) {
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
      return handleAdminApi(request, env, url, email);
    }

    // Only paths no static asset matched reach here; the assets layer
    // answers with the site's 404 page.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
