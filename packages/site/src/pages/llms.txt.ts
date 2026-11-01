import type { APIRoute } from "astro";
import { links, SITE } from "../data/links";
import { t } from "../i18n";

const faq = t("en")
  .faq.items.map((item) => `- **${item.q}** ${item.a}`)
  .join("\n");

const body = `# Cardex

> Cardex helps people decide which Hong Kong credit card to use by giving their AI assistant structured, sourced facts about rebate rates, caps, and card terms. The assistant compares and answers; Cardex itself never ranks cards or names a best card.

Cardex is a pair: an Agent Skill that teaches an assistant what to check before it answers (caps, registration, exclusions, effective dates), and a public remote MCP server that returns the facts. It is open source under the MIT licence.

Status: pre-alpha. Every figure currently served is illustrative synthetic data, not real issuer terms; responses mark this with \`provenance.illustrative: true\`.

## Set up

- [Skill](${links.skill}): save as \`cardex/SKILL.md\` in the assistant's skills directory. Also usable as plain instructions for assistants without skill support.
- MCP endpoint: \`POST ${links.mcp}\` (streamable HTTP, stateless, no auth, no sign-up).
- MCP client config: \`{ "mcpServers": { "cardex": { "url": "${links.mcp}" } } }\`

## What it does not do

- Does not rank cards or recommend a best card.
- Does not take card numbers, store which cards a user holds, or see transactions.
- Does not scrape bank sites at request time; facts are curated and every change is human-approved against the issuer's page.

## FAQ

${faq}

## Pages

- [Home (繁體中文，香港)](${SITE}/): landing page in spoken Hong Kong Cantonese
- [Home (English)](${SITE}/en): English landing page
- [Source code](${links.github}): Worker, skill, product spec (docs/PRD.md) and decision records (docs/adr/)
`;

export const GET: APIRoute = () =>
  new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });
