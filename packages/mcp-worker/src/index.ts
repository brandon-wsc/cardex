import { createMcpHandler } from "agents/mcp/server";

import adminHtml from "./admin.html";
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
  }
}

const ABOUT = {
  name: "cardex",
  description:
    "Structured Hong Kong credit-card facts for agents: rates, terms, tags, aliases. Facts only; the caller ranks.",
  mcp_endpoint: "/mcp",
  maintainer_endpoint: "/maintainer",
  docs: "https://github.com/brandon-wsc/cardex",
};

const json = (body: unknown, status = 200) =>
  Response.json(body, { status });

// The real boundary is the Cloudflare Access app in front of /admin (email
// OTP, owner only) — this checks its verified identity header as a second
// layer and enforces the owner address. DEV_ADMIN_EMAIL exists so local
// `wrangler dev` can exercise the portal without Access; it stays unset in
// production.
function adminIdentity(request: Request, env: Env): string | null {
  const email =
    request.headers.get("Cf-Access-Authenticated-User-Email") ??
    env.DEV_ADMIN_EMAIL ??
    null;
  if (!email) return null;
  if (env.ADMIN_EMAIL && email !== env.ADMIN_EMAIL) return null;
  return email;
}

async function handleAdminApi(
  request: Request,
  env: Env,
  url: URL,
  email: string,
): Promise<Response> {
  const path = url.pathname.slice("/admin/api".length);

  if (path === "/me" && request.method === "GET") {
    return json({ email });
  }
  if (path === "/reports" && request.method === "GET") {
    return json(await listReports(env.DB, {}));
  }
  if (path === "/proposals" && request.method === "GET") {
    return json(
      await listProposals(env.DB, {
        status: url.searchParams.get("status") ?? undefined,
      }),
    );
  }

  const decideMatch = path.match(/^\/proposals\/([^/]+)\/decide$/);
  if (decideMatch && request.method === "POST") {
    const body = (await request.json().catch(() => ({}))) as {
      decision?: string;
      note?: string;
      pin?: string;
    };
    if (env.ADMIN_PIN && body.pin !== env.ADMIN_PIN) {
      return json({ ok: false, error: "bad_pin" }, 403);
    }
    if (body.decision !== "approve" && body.decision !== "reject") {
      return json({ ok: false, error: "invalid_decision" }, 400);
    }
    const res = await decideProposal(env.DB, decideMatch[1], {
      decision: body.decision,
      decided_by: email,
      note: body.note,
    });
    return json(res, res.ok ? 200 : 400);
  }

  const getMatch = path.match(/^\/proposals\/([^/]+)$/);
  if (getMatch && request.method === "GET") {
    const res = await getProposal(env.DB, getMatch[1]);
    return json(res, res.ok ? 200 : 404);
  }

  return json({ ok: false, error: "not_found" }, 404);
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return Promise.resolve(json(ABOUT));
    }

    if (url.pathname === "/mcp") {
      const mcp = createMcpHandler(() => buildServer(env.DB), {
        route: "/mcp",
      });
      return mcp(request, env, ctx);
    }

    if (url.pathname === "/maintainer") {
      if (!env.MAINTAINER_TOKEN) {
        return Promise.resolve(new Response("Not found", { status: 404 }));
      }
      if (
        request.headers.get("Authorization") !==
        `Bearer ${env.MAINTAINER_TOKEN}`
      ) {
        return Promise.resolve(json({ error: "unauthorized" }, 401));
      }
      const mcp = createMcpHandler(() => buildMaintainerServer(env.DB), {
        route: "/maintainer",
      });
      return mcp(request, env, ctx);
    }

    if (url.pathname === "/admin" || url.pathname === "/admin/") {
      if (!adminIdentity(request, env)) {
        return Promise.resolve(new Response("Unauthorized", { status: 401 }));
      }
      return Promise.resolve(
        new Response(adminHtml, {
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      );
    }

    if (url.pathname.startsWith("/admin/api/")) {
      const email = adminIdentity(request, env);
      if (!email) {
        return Promise.resolve(json({ error: "unauthorized" }, 401));
      }
      return handleAdminApi(request, env, url, email);
    }

    return Promise.resolve(new Response("Not found", { status: 404 }));
  },
} satisfies ExportedHandler<Env>;
