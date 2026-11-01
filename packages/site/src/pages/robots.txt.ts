import type { APIRoute } from "astro";
import { SITE } from "../data/links";

export const GET: APIRoute = () =>
  new Response(`User-agent: *\nAllow: /\nDisallow: /admin\n\nSitemap: ${SITE}/sitemap.xml\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
