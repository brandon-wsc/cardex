import score from "./demo-score.json";

// demo-score.json is the verbatim structuredContent of this call against the
// local seed (pnpm migrate && pnpm seed && pnpm dev). Regenerate it with the
// same request after a seed change; never hand-edit the numbers.
//   tools/call score_candidates
//   { "amount_hkd": 280, "alias": "茶餐廳", "merchant": "譚仔", "card_ids": ["card_hsbc_red", "card_aeon"] }
export const demoCall = {
  amount_hkd: 280,
  alias: "茶餐廳",
  merchant: "譚仔",
  card_ids: ["card_hsbc_red", "card_aeon"],
} as const;

export const demoScore = score;

export function unknownKey(entry: string): string {
  return entry.split(":")[0];
}
