// Issuer and network aliases live in code, not D1: both sets are near-closed
// (~20 HK issuers, a handful of networks), so one file is easier to review
// than seed rows scattered between tag and card aliases.
//
// Keys are matched case-insensitively with collapsed whitespace — write them
// lowercase. Both resolve_alias and lookup_rates' issuer filter match keys
// with the same rule: exact, or either-contains when both sides are at
// least 2 characters. Values must equal the canonical cards.issuer /
// cards.network strings, so a resolved issuer feeds straight into
// lookup_rates(issuer).

export const ISSUER_ALIASES: Record<string, string> = {
  hsbc: "HSBC",
  匯豐: "HSBC",
  citi: "Citi",
  citibank: "Citi",
  花旗: "Citi",
  sc: "Standard Chartered",
  scb: "Standard Chartered",
  "standard chartered": "Standard Chartered",
  渣打: "Standard Chartered",
  aeon: "AEON",
  dbs: "DBS",
  星展: "DBS",
  boc: "BOC",
  中銀: "BOC",
  "hang seng": "Hang Seng",
  恒生: "Hang Seng",
  mox: "Mox",
  "za bank": "ZA Bank",
};

export const NETWORK_ALIASES: Record<string, string> = {
  visa: "visa",
  mastercard: "mastercard",
  mc: "mastercard",
  萬事達: "mastercard",
  amex: "amex",
  "american express": "amex",
  unionpay: "unionpay",
  銀聯: "unionpay",
  jcb: "jcb",
};
