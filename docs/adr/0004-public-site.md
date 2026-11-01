# ADR 0004 — Public site on the same Worker: Astro static assets, Preact admin island

- **Status:** Accepted
- **Date:** 2026-11-01

## Context

`cardex.brandonhk.com/` returned a JSON descriptor and nothing else. People who land on the domain — the ones who would install Cardex into their own AI assistant — had no page telling them what it does for them or how to set it up. Answer engines had nothing to crawl either.

The audience split is now explicit. **Tools serve agents; the site serves people.** A person wants to know which card to tap; their assistant uses Cardex to get there. The site talks about that benefit; the tool contract stays facts-only ([ADR 0001](0001-product-shape.md)). The site never names a best card either — the PRD's "no copy that names a best card" binds marketing copy too.

The admin portal ([ADR 0002](0002-maintenance-surface.md)) was a 600-line HTML string with hand-rolled `innerHTML` rendering, imported as a text module. Adding a second UI surface was the moment to give both a build step.

Options weighed:

- **Separate repo / Pages project owning the hostname** — forces `/mcp` onto a new host, breaking every caller's `mcpServers` config, the skill, and the Access app. A path-routed second Worker on the same host avoids the break but splits one small product across two deploys and loses same-repo access to `skills/cardex` for `/skill.md`.
- **One more HTML string in the Worker** — no build step, but no i18n, no typecheck on the admin script, and every future page is another string.
- **Astro static output on the same Worker** — one deploy, one hostname, zero JS on public pages, typed islands where interaction is needed.

## Decision

1. **`packages/site` is an Astro project with `output: "static"`** and no SSR adapter. Its `dist/` is the Worker's static assets directory (`assets.directory` in `wrangler.jsonc`, binding `ASSETS`). The Worker stays the owner of the hostname and the only deploy.
2. **Routing.** `run_worker_first` covers `/mcp`, `/maintainer`, and `/admin*` (including the built `/admin.html`); everything else is asset-first. `/admin` is served by the Worker *after* the existing `adminIdentity` check, via `env.ASSETS.fetch` — static hosting never bypasses the second layer behind Access. Paths no asset matches fall through to the Worker, which returns the site's 404 page.
3. **Islands are Preact.** The admin portal is one `client:only` island — same `/admin/api/*` calls, same behaviour. The landing page ships one tiny island (copy-prompt) and otherwise no JS. React is not used: the islands are small and Preact keeps the bundle small.
4. **Two locales, real URLs.** `zh-HK` (spoken Cantonese) at `/`, `en` at `/en`, with `hreflang` alternates and `x-default` → `/`. Copy lives in typed dictionaries under `packages/site/src/i18n/`; `zh-HK` defines the shape. No language toggle that hides one locale in the same document, no geo or `Accept-Language` redirect. The admin portal stays English-only.
5. **Answer-engine surface, generated at build:** `/llms.txt`, `/robots.txt`, `/sitemap.xml` (with locale alternates), JSON-LD (`SoftwareApplication`, `FAQPage`), and `/skill.md` — copied from `skills/cardex/SKILL.md` at build so the skill has one source and a stable public URL for the setup prompt.
6. **Demo content is real tool output.** The example answer on the landing page renders a committed `score_candidates` response against the seed, labelled illustrative. Copy is never hand-computed numbers.
7. **No tracking.** Fonts are self-hosted (`@fontsource`); no analytics, cookies, forms, or third-party scripts. Adding any of these needs a superseding ADR.
8. The `/` JSON descriptor is retired; `/llms.txt` is the machine-readable entry point.

## Consequences

- The Worker deploy now depends on a site build: CI and the deploy workflow build `packages/site` before `wrangler` runs, and the deploy triggers on `packages/site/**` and `skills/cardex/**` as well as the Worker.
- `packages/site` pins TypeScript 6 because `@astrojs/check` does not support TypeScript 7; the Worker stays on 7.
- Admin JS is a public asset under `/_astro/`. It holds no secrets — the boundary remains Access plus the Worker's identity check on `/admin` and `/admin/api/*`.
- New copy is written twice (zh-HK and en). A missing key fails `astro check`.
- Adding SSR, a second Worker, analytics, or a third locale each needs a new ADR.
