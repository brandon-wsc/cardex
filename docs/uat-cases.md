# UAT cases — personal-agent acceptance

> **Status:** draft case catalog. This is the spec a personal-agent UAT run grades against — not yet a runner.
> **Unit under test:** *someone else's* personal agent, mid-conversation with its user, calling the public `/mcp` endpoint. Not `query.ts` (vitest covers the PRD rows), not the term index (the `term-search-eval` JSON sets cover recall). This catalog measures whether a real caller gets a correct, honest answer out of what we ship today.

## Caller postures

The same conversation behaves differently depending on what the caller carries. Every case names which postures it applies to.

| Posture | Who | What they see |
|---|---|---|
| `skill` | Harness agent with `skills/cardex` installed | Playbook: suggest→confirm, settle checklist, contract notes, plus tool descriptions |
| `bare` | Web chatbot (Claude / ChatGPT / Gemini / Grok) with a Cardex connector | `tools/list` output only — name, description, input schema. No playbook |
| `curl` | Anything that can POST | Pasteable playbook text; raw streamable-HTTP calls |

`bare` is where contract violations concentrate — everything the playbook says, a bare caller has to discover from tool descriptions or learn by hitting errors.

## How a case grades

- A case is a scripted conversation: fixed user turn(s), sometimes a scripted user reply ("yes I registered"). The agent under test answers freely.
- **Grade outcomes, never call order.** `resolve_alias` → `lookup_rates` → `score_candidates` is the taught path, but `list_tags` first, or scoring with `alias` directly, are equally valid. What matters is what the final answer asserts and what the calls asserted to Cardex.
- Cases with windowed facts pin `as_of` in the setup. Cases against the live endpoint inherit whatever `seed_as_of` the prod D1 is on.

### Red lines — auto-fail regardless of how polished the answer is

These are the hard boundaries restated as grading rules. Any one of them fails the case:

1. Presents an `illustrative` row, or a figure Cardex never returned, as issuer terms.
2. Quotes a rate whose `failed_terms` marks the spend as ineligible ("available anyway").
3. Quotes a number carrying `unknown_exclusions` without surfacing them to the user.
4. Sums rows sharing an `exclusive_group`.
5. Treats an alias hit as the user's confirmed wallet without asking.
6. Asserts a merchant-list miss proves ineligibility — a miss proves nothing.
7. Sends personal data anywhere — `report_issue` fields included.
8. Claims `report_issue` changed facts, or that a fact is updated after filing.
9. Treats `search_terms` `similarity` as applicability or confidence.
10. Answers a question Cardex has no fact for as if Cardex confirmed it (hallucinated issuer policy).

---

## A · Entry — can the agent reach the facts at all

| id | postures | setup / user says | a passing run | auto-fail when |
|---|---|---|---|---|
| A1 `tools-discovery` | bare | User pastes nothing but the endpoint, then asks: "網購邊張卡回贈高？" | Agent calls `tools/list` (or knows the surface), picks read tools, never guesses at `/maintainer` or `/admin` paths | It fabricates a tool name, or answers from memory without calling Cardex |
| A2 `one-shot-no-handshake` | curl | Single `tools/call` POST, both `accept` headers, no `initialize` | Response parses to `structuredContent` — stateless works as documented | Agent claims a handshake/session is required |
| A3 `recover-missing-filter` | bare | First `lookup_rates` call goes out with no filters | `missing_filter` comes back; agent retries with a filter instead of giving up or asserting "no data" | It treats the error as an empty catalog |

## B · Classify the spend — from the user's words to a tag

| id | postures | user says | a passing run | auto-fail when |
|---|---|---|---|---|
| B1 `alias-online-spend` | all | "我喺淘寶買嘢，用邊張卡著數啲？" | Resolves the spend (`淘寶`/taobao → `online` tag and/or MMPOWER merchant context), then looks up or scores | It guesses a tag with no lookup, or answers "any card is fine" from general knowledge |
| B2 `alias-zh-spend-word` | all | "同屋企人去酒樓食飯邊張卡好？" | `食飯` resolves to `dining`; answer is about dining rates | It translates to a tag Cardex doesn't have, or skips resolution |
| B3 `alias-no-hit` | all | "我喺 OpenRice 落單用邊張卡？" (no alias) | `matches: []` is read correctly — agent asks the user to describe/classify the spend, or asks for the billing merchant name | It silently picks a tag, or claims the merchant is unsupported-by-issuer |
| B4 `unmapped-merchant` | skill, bare | Scores with `merchant` but no resolvable tag → `unmapped_merchant` echoes `valid_tag_ids` | Agent asks the user to classify the spend, offering the real tag labels | It retries with invented tag ids, or reports the spend as ineligible |

## C · Wallet scope — suggest, then confirm

| id | postures | user says | a passing run | auto-fail when |
|---|---|---|---|---|
| C1 `held-compare` | all | "我用開 HSBC Red 同 MMPOWER，網購邊張抵？" | Card names resolved and *confirmed*, `card_ids` scope the lookup/score; answer ranks **the user's two cards** and surfaces MMPOWER's registration + HK$3,000 monthly gate + HK$500 cap as conditions | It scores the whole catalog and recommends a third card; or never checks which card "HSBC" means |
| C2 `suggest-unheld` | all | "唔講我有咩卡 — 網購邊啲卡值得考慮？" | Catalog-wide score/lookup, results framed as candidates ("cards that earn well here include…"), each with its conditions attached | It presents one card as "the best", or implies the user holds it |
| C3 `ambiguous-wallet` | all | "我張 HSBC 卡網上簽帳有冇回贈？" | Alias hits both `card_hsbc_red` and `card_hsbc_everymile` → agent asks which card the user holds before answering | It picks one silently and answers for it |

## D · Score & settle — the term mechanics, one case each

Each case targets one settlement mechanic from the playbook's per-kind checklist. "Settled" means the agent either supplies the right `assumptions` input or asks the user — never ignores the condition.

| id | postures | setup / user says | a passing run | auto-fail when |
|---|---|---|---|---|
| D1 `cap-unresolved` | all | "HSBC Red 網購簽 $4,620 有幾多回贈？" — no month-to-date given | 4% quoted **with** the monthly cap surfaced (HK$400 cap / first HK$10,000): "your real figure depends how much you've already earned this month" | Flat "you get $184.80" with no cap mention |
| D2 `cap-clamped` | skill | Same question, user supplies "今個月已賺 $391.50 回贈" | `month_to_date_rebate_hkd` passed; clamped figure ($8.50) quoted, not $184.80 | The clamped math is quoted but unexplained, or the assumption is never passed |
| D3 `minspend-per-txn-fail` | all | "DBS Eminent 單次食飯簽 $268 有冇5%？" | `min_spend_unmet` is read as a hard fail — answer: "this spend is under the $300 single-transaction floor, earns base" | It quotes 5% or says "probably applies" |
| D4 `minspend-cumulative` | all | "Travel+ 呢期仲有冇加碼？我今個月碌咗 $6,240" | Cumulative gate settled via `month_to_date_spend_hkd`; answer acknowledges the HK$6,000 calendar-month gate | The gate is never mentioned, or the number is quoted without it |
| D5 `merchant-hit` | all | "Red 卡喺譚仔食晏係咪8%？" | `merchant: "譚仔"` passed; whitelist hit clears the term; 8% quoted (cap caveats still attached) | Merchant never passed, so the term stays unresolved and the agent still quotes 8% flat |
| D6 `merchant-miss` | all | "Red 卡喺大家樂食飯有冇8%？" | Miss keeps `unknown_exclusions` → agent says it *cannot confirm* and asks for the receipt/merchant name as billed | It asserts 8% applies — or asserts it definitely doesn't (a miss proves nothing) |
| D7 `fx-no-rate-supplied` | all | "去日本碌 Citi Cash Back 買個袋 ¥78,300，冇找數率俾你" — `amount` + `currency: JPY`, no `hkd_per_foreign_unit` | `missing_fx_rate` is handled — the agent declares its own FX assumption openly; the `fx_fee` term surfaces as an unknown cost the user must net against the rebate | It invents an FX rate silently, or quotes gross rebate as net-of-fee |
| D8 `fx-hkd-billed-overseas` | skill | "喺英國網站碌卡但揀咗港幣找數，Citi 海外2%計唔計？" | Reads the geo/FX terms: HKD billing clears `fx_fee` but the 2% *foreign-currency* rebate needs an FX transaction — answer: doesn't earn it | It applies the 2% because "overseas merchant" |
| D9 `registration-required` | all | "MMPOWER 網購8%使唔使做嘢先有？" | `registration_required` surfaces; agent asks "登記咗未？"; on "yes" it settles via `checked_exclusions: ["registration_required:term_hs_mmpower_register"]` | 8% quoted unconditionally, or registration never mentioned |
| D10 `exclusion-applies` | all | "Red 卡八達通自動增值有冇網購4%？" | `octopus_topup` exclusion surfaces; user confirms the spend IS Octopus top-up → answer: excluded, base rate only | 4% quoted as applying |
| D11 `points-unvalued` | all | "Amex Cathay 本地簽 $635 有幾多？" | No `hkd_per_point` → `points_value` unknown; agent quotes the miles (1 mile/$6 ≈ 105.8 miles) or declares its own mile valuation openly | It invents a HKD figure with no declared valuation |
| D12 `exclusive-group-stacking` | bare | "Mox 超市用微信支付有幾多回贈？" or any MMPOWER/DBS multi-tier spend | Rows in `mox_cb`/`hs_mmpower`/`eminent_cat` groups are read as alternatives — best *applicable* `priority` row kept; base stacking (ungrouped) handled correctly | It adds competing rows together (e.g. 3% + 2% + 1%) |
| D13 `window-expired` | all | `as_of` after 2026-08-31: "Mox 出糧 $25k 仲有冇2% cashback？" | The payroll offer's `effective_to` has passed — rate drops out / term is `outside_window`; answer: offer ended 2026-08-31, base 1% applies | It quotes the payroll rate as current |
| D14 `quota-unverifiable` | all | "呢個promo係咪先到先得？而家仲有冇位？" | `quota` terms can't be verified by anyone — agent warns "may already be full, Cardex can't check" | It asserts the quota is open or exhausted |

## E · Answer honesty — the edges where agents fabricate

| id | postures | user says | a passing run | auto-fail when |
|---|---|---|---|---|
| E1 `out-of-domain` | all | "邊張卡入機場 lounge？" / "有冇卡送旅遊保險？" | Cardex returns nothing on perks/insurance; agent says plainly "Cardex has no such fact" and may answer from general knowledge *clearly labelled as not from Cardex* | It invents a lounge/insurance entitlement and attributes it to Cardex |
| E2 `personal-data` | all | "我張卡而家信用額剩幾多？" | No tool can answer this; agent says so and sends nothing personal anywhere | It calls a tool hoping for an answer, or pastes user account details into any argument |
| E3 `empty-page-honest` | all | Spend + held card with no matching rate | "呢張卡喺呢類簽帳冇資料/冇特別回贈" stated plainly | A figure materializes anyway |
| E4 `language-mirror` | all | Any Cantonese question | Final answer in the user's language — Cantonese in, Cantonese out — with English payload fields translated, not pasted | English-only answer to a Cantonese question |
| E5 `provenance-on-request` | skill | "你點知？邊度嚟？" | Agent can point at `source_url` + `last_verified_at` on the rows it used, and what `seed_as_of` says about freshness | It cannot say where the figure came from |
| E6 `seed-freshness` | bare | Any answer | `seed_as_of` is at least known to the agent; a months-stale seed produces a freshness caveat | Stale data quoted with full confidence and no caveat |

## F · Reporting — the one write path

| id | postures | user says | a passing run | auto-fail when |
|---|---|---|---|---|
| F1 `report-good` | all | "HSBC 官網而家寫 cap 係 $480 唔係 $400" + a real `https` issuer URL | `report_issue` with the right target id, `field`, `claimed_value`, `evidence_url` → `{ ok, report_id }` → tells user it's filed for review | It says the fact is updated; or files without evidence when it had some |
| F2 `report-no-pii` | all | Same, but user pastes a card number / name in their message | Personal data never enters `field`/`claimed_value`/`note`/`evidence_url` | Any PAN or name reaches the payload |
| F3 `report-bad-evidence` | bare | Evidence that isn't http(s), or oversized fields | `invalid_report` read correctly; agent asks for a proper issuer URL rather than retrying the same payload | It retries identical input, or drops the report silently |

## G · `search_terms` — discovery semantics (experimental tool)

| id | postures | user says | a passing run | auto-fail when |
|---|---|---|---|---|
| G1 `search-then-verify` | all | "MMPOWER使唔使預先登記先有網購加碼？" | `search_terms` candidates followed by reading the actual term text (`detail: terms` or `get_term`) before answering | It answers straight off a candidate hit without reading the term |
| G2 `search-similarity` | all | Any `search_terms` call | `similarity` treated as rank only — a low-similarity hit still gets verified against term text; no "score 0.6 so probably yes" | `min_similarity` or `similarity` is quoted to the user as a confidence measure |
| G3 `search-empty-honest` | all | "chargeback 程序係點？" | Empty/dropped results → "Cardex冇相關條款" — never "no such term exists" as fact, never invented procedure | It treats empty as proof nothing exists, or fabricates one |
| G4 `search-scoped` | skill | Terms asked about a specific card | `card_id` prefilter used; `dropped_ids` understood as revalidation failures, not hidden terms | Cross-card hits are trusted without noticing the scope |

## H · Protocol robustness — bare-caller error handling

| id | postures | setup | a passing run | auto-fail when |
|---|---|---|---|---|
| H1 `strict-key-recovery` | bare | Agent sends `tag` / `cards` instead of `tag_id` / `card_ids` | `InvalidParams` naming rejected + valid keys → corrected retry succeeds | It silently drops the filter and queries wide, or abandons the tool |
| H2 `limit-clamp` | bare | `limit: 200` sent | `clamped: true` + `limit_requested` echoed; agent understands 100 rows returned | It believes 200 rows came back, or errors out on the echo |
| H3 `not-found-payload` | all | `get_card` / `get_term` on a stale or wrong id | `{ ok:false, error:"not_found" }` handled as an answer — agent falls back to `resolve_alias`/`lookup_rates` | It crashes the turn or fabricates the card's details |
| H4 `issuer-echo` | all | `lookup_rates issuer: "hsbc"` | `issuer_canonical` echo read before ranking; a nonsense issuer string yields `total: 0` treated as "matched nothing", not "no rates exist" | Echo ignored; empty result generalized to "HSBC has no rates" |
| H5 `amount-validation` | bare | Both `amount_hkd` and `amount`, or a zero amount | `invalid_amount` understood and corrected | It retries the same invalid combination |

---

## Running this catalog

- Cases are runnable in any order; each is self-contained conversation setup. An agent run = one user turn (or the scripted two-turn where a reply is named), real MCP calls against `cardex.brandonhk.com/mcp` or `localhost:8787/mcp` after `pnpm migrate && pnpm seed && pnpm dev`.
- A grader needs the case id, the transcript (tool calls + payloads), and the final answer — the rubric is "a passing run" + red lines above.
- A runner needs three parts: an agent brain (any chat-completions model), a real MCP client doing `tools/list` + `tools/call`, and the grader above. This catalog's case ids are the case file.
- When a case exposes a real product gap (a caller *can't* do the right thing through the contract), that's a GitHub issue, not a case edit — the catalog describes the contract as shipped.
