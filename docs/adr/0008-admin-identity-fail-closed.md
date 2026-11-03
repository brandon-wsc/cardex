# ADR 0008 — Admin identity fails closed

- **Status:** Accepted
- **Date:** 2026-11-03
- **Supersedes:** [0002](0002-maintenance-surface.md) §"Three surfaces, three credentials" item 3, for the in-Worker identity check only

## Context

ADR 0002 made the Cloudflare Access app the real boundary for `/admin` and had the Worker trust `Cf-Access-Authenticated-User-Email` as a second check, with `DEV_ADMIN_EMAIL` covering local dev. Both are safe only while Access actually fronts the request: the header is attacker-controlled on any path that bypasses the app, and a `DEV_ADMIN_EMAIL` leaking into prod vars would mint an identity for any caller. The Worker could not tell whether the boundary was in place — a deployment slip turned admin auth off silently.

## Decision

The in-Worker identity check fails closed. When `ACCESS_TEAM` + `ACCESS_AUD` are set, the signed `Cf-Access-Jwt-Assertion` remains the only identity source (unchanged). When they are not set, the header/`DEV_ADMIN_EMAIL` fallback applies only on loopback hostnames (`localhost`, `127.0.0.1`, `[::1]`, `*.localhost` — i.e. `wrangler dev`) or when `ALLOW_DEV_IDENTITY=true` is set explicitly for non-local dev setups. On any other hostname there is no fallback — requests get 401. `workers_dev` is pinned `false` in `wrangler.jsonc` so the workers.dev hostname cannot be re-enabled by accident.

## Consequences

- A prod deploy without Access configured now 401s `/admin` instead of silently trusting a spoofable header — misconfigurations are loud, not open.
- Production must set `ACCESS_TEAM`/`ACCESS_AUD` (with the Access policy) before or with this deploy; the portal is unreachable until then.
- `ALLOW_DEV_IDENTITY` re-opens header mode if set in prod — it is documented dev-only, and even then the blast radius equals the old default, never worse.
- Local `wrangler dev` is unchanged: loopback requests keep the header/`DEV_ADMIN_EMAIL` path with no extra config.
