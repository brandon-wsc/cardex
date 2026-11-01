import type { APIRoute } from "astro";
import { SITE } from "../data/links";
import { localePath, locales } from "../i18n";

const pages = ["/"];

export const GET: APIRoute = () => {
  const urls = pages.flatMap((path) =>
    locales.map((locale) => {
      const alternates = locales
        .map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${SITE}${localePath(l, path)}"/>`)
        .concat(`    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}${localePath("zh-HK", path)}"/>`)
        .join("\n");
      return `  <url>\n    <loc>${SITE}${localePath(locale, path)}</loc>\n${alternates}\n  </url>`;
    }),
  );
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${urls.join("\n")}
</urlset>
`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8" } });
};
