import type { APIRoute } from "astro";
import skill from "../../../../skills/cardex/SKILL.md?raw";

export const GET: APIRoute = () =>
  new Response(skill, { headers: { "content-type": "text/markdown; charset=utf-8" } });
