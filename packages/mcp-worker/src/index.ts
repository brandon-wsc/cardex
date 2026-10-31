import { createMcpHandler } from "agents/mcp/server";

import { buildServer } from "./server.js";

const ABOUT = {
  name: "cardex",
  description:
    "Structured Hong Kong credit-card facts for agents: rates, terms, tags, aliases. Facts only; the caller ranks.",
  mcp_endpoint: "/mcp",
  docs: "https://github.com/brandon-wsc/cardex",
};

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/") {
      return Promise.resolve(Response.json(ABOUT));
    }
    const mcp = createMcpHandler(() => buildServer(env.DB));
    return mcp(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
