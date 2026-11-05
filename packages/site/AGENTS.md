# site

Astro (`output: "static"`, no adapter) whose `dist/` is the Worker's static assets ([ADR 0004](../../docs/adr/0004-public-site.md)).

Pages talk to people; tools talk to agents — site copy may promise the benefit (knowing which card to tap) but never names a best card, invents a metric, or hand-writes demo numbers (`src/data/demo-score.json` is a verbatim tool response; regenerate per `src/data/demo.ts`).

zh-HK is spoken Cantonese at `/`; en at `/en`. `zh-HK.ts` defines the copy shape and `en.ts` must match — no copy strings in components. Islands are Preact; the landing page ships only the copy button.

`run_worker_first` keeps `/mcp`, `/maintainer`, and `/admin*` ahead of assets — `/admin` is served from `ASSETS` only after the identity check.

Astro needs Node ≥ 22.23.4 and TypeScript 6 (`@astrojs/check`); the Worker stays on TypeScript 7. Check pages at 375px and 1440px before calling UI work done.
