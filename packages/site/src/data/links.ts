export const SITE = "https://cardex.brandonhk.com";

export const links = {
  github: "https://github.com/brandon-wsc/cardex",
  mcp: `${SITE}/mcp`,
  skill: `${SITE}/skill.md`,
  llms: `${SITE}/llms.txt`,
} as const;

export const mcpConfig = `{ "mcpServers": { "cardex": { "url": "${links.mcp}" } } }`;
