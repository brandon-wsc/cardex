# Term-kind audit — HK issuer sources

Audit of real promo mechanics vs the v0.3 term-kind enum
(`cap, exclusion, fx_fee, min_spend, registration_required, channel, mcc`).
Primary issuer sources only. Conducted against products: HSBC Red + 最紅自主獎賞,
SC Simply Cash + SC targeted offers, Citi Cash Back / PremierMiles / Rewards,
BOC Chill, Mox Credit, Hang Seng MMPOWER + enJoy, DBS Eminent + Black MC promo +
Subscription Bonus Club, AEON Card + AEON DAY.

## (a) Findings: mechanic → enum kind

| # | Mechanic observed | Enum kind | Issuer source |
|---|-------------------|-----------|---------------|
| 1 | Cap per **calendar month** | `cap`, period=`calendar_month` | HSBC Red: 4% RC on first HK$10,000 online per calendar month, then 0.4% — https://www.hsbc.com.hk/credit-cards/products/red/ . DBS Eminent: first HK$8,000 (VS)/HK$4,000 (Plat) designated + first HK$20,000/HK$15,000 other retail + first HK$5,000 e-wallet, per calendar month — https://www.dbs.com.hk/personal/promotion/eminent-5percent-cashrebate . MMPOWER: $500 +FUN monthly cap — https://www.hangseng.com/en-hk/personal/cards/products/mmpower-card/ . BOC Chill: accrual counted per calendar month — https://www.bochk.com/dam/boccreditcard/chillcard/chill_tnc_EN.pdf cl.3 |
| 2 | Cap per **statement cycle** | `cap`, period=`statement_cycle` | Citi Rewards: bonus points capped 113,400 per statement cycle — https://www.citibank.com.hk/english/credit-cards/pdf/rewards-card/terms-and-conditions.pdf |
| 3 | Cap per **promo period** | `cap`, period=`promo_period` | HSBC RYC: extra RC on first HK$100,000, max $2,000 over programme validity — https://www.redhotoffers.hsbc.com.hk/media/100629196/TC_SC_2025_2026_RYC.pdf cl.2 . DBS Sub Club: max 21 rewards / HK$420 whole promo — https://www.dbs.com.hk/personal/promotion/subscription |
| 4 | Cap per **event/promo date** | `cap`, period=`event_date` | AEON DAY: max 25,000 extra points per promotion date — https://www.aeon.com.hk/en/privilege/promotion_10xbp_0324.html |
| 5 | Cap per **promo phase** | `cap`, period=`promo_phase` (or N `promo_period` rows) | SC Pay FPS rebate: HK$80,000 transfer cap / HK$1,400 rebate per phase, 2 phases — https://av.sc.com/hk/edm/ways-to-bank/scpay-a-202505/zh/images/tnc.pdf cl.3 |
| 6 | Min spend per **transaction** | `min_spend`, period=`per_transaction` | DBS Eminent: single net ≥HK$300 to hit 5% tier — same URL as #1. AEON DAY: ≥HK$500 single transaction — AEON URL as #4. DBS Sub Club: single ≥HK$30 — https://www.dbs.com.hk/iwov-resources/pdf/creditcards/Shop_ServiceSubscription_2026Q2_TnC_EN.pdf cl.4 |
| 7 | Min spend **cumulative per month** (rate gate) | `min_spend`, period=`calendar_month` | MMPOWER: ≥HK$3,000 eligible spend/calendar month — https://www.hangseng.com/content/dam/wpb/hase/rwd/personal/cards/pdfs/everyday_tnc_en.pdf cl.3 . BOC Chill: ≥HK$1,500 physical+mobile-pay retail/month unlocks 10% Chill tier — chill_tnc_EN.pdf cl.20+ |
| 8 | Min spend cumulative per **statement cycle** (tier upgrade) | `min_spend`, period=`statement_cycle` | Citi PremierMiles: ≥HK$20,000 total eligible spend in a statement cycle upgrades FX/online to HK$3=1 mile (else HK$4) — https://www.citibank.com.hk/english/credit-cards/premiermiles-card-tnc/ |
| 9 | Min spend over **anchored rolling window** (welcome) | `min_spend`, period=`rolling_window` + anchor | HSBC Red welcome: HK$12,000 within 60 days of issuance — hsbc.com.hk/credit-cards/products/red/ . Citi welcome: HK$5,000 in first 2 months + ≥1 eligible txn each month — https://www.citibank.com.hk/english/credit-cards/welcome-offers/tnc/ . AEON welcome: HK$6,000 within 60 days of welcome SMS — https://www.aeon.com.hk/en/privilege/promotion_welcomeoffer_0325.html . BOC Chill: within first month + next 2 calendar months of issuance — https://www.bochk.com/dam/boccreditcard/chillcard/chill_wg_en.pdf |
| 10 | Registration / opt-in | `registration_required` | HSBC RYC: once, by 31 Oct 2026, via Reward+/web — TC_SC_2025_2026_RYC.pdf cl.3. MMPOWER: once in promo period — everyday_tnc_en.pdf cl.2. DBS Eminent: **re-register every year** — https://www.dbs.com.hk/iwov-resources/pdf/creditcards/eminent-tnc-5percent-rebate2026-en.pdf cl.3. DBS promos via Card+ app before eligible txns. AEON DAY: once on AEON HK app |
| 11 | **Quota** (first N registrants / FCFS rewards) | **GAP → `quota`** | DBS Black MC promo: first 10,000 registrants only — https://www.dbs.com.hk/iwov-resources/pdf/creditcards/BlackMC_overseas_spend_2026Q3_TnC_EN.pdf cl.4. DBS Sub Club: reward quotas FCFS — subscription page remark 2 |
| 12 | **Named merchant whitelist** | **GAP → `merchant_list`** | HSBC Red 8% tier named list (Sushiro, TamJai, Bakehouse, Decathlon, NAMCO, TAITO, Sephora…) — product page. HSBC RYC Shopping/Home/Lifestyle designated lists — https://www.redhotoffers.hsbc.com.hk/tc/rewards/red-hot-rewards-of-your-choice/details. BOC Chill merchants — https://www.bochk.com/s/a/chill. Mox CashBack Merchants — https://mox.com/static/260227_Mox_Card_Rewards_Table.pdf. enJoy yuu merchant list — https://www.hangseng.com/content/dam/wpb/hase/rwd/personal/cards/pdfs/2025/sep/yuu_reward_pt_TnC_EN.pdf |
| 13 | MCC-based category | `mcc` | HSBC RYC Dining by Visa/MC/CUP merchant codes (RYC T&C cl.5i). MMPOWER online fashion by MCC (everyday_tnc cl.4b). Citi Cash Back dining/hotel by merchant codes — https://www.citibank.com.hk/english/credit-cards/cashback-card-spending-rebate-tnc/. DBS Eminent designated categories by Visa/acquirer codes |
| 14 | Channel restriction (online / physical / wallet / app) | `channel` | Online: HSBC Red 4%; MMPOWER online cats; BOC Chill online. Physical-only: MMPOWER FX spend = physical stores abroad (everyday_tnc cl.4d). Wallet-scoped: Mox 3% supermarkets excludes WeChat Pay/Alipay — Rewards Table; Citi Rewards mobile-payments programme; BOC mobile pay (Apple/Google/Samsung) counts to threshold; DBS e-wallet first HK$5k cap. Application channel: AEON +HK$200 for app/web application. Card-present vs not: Citi FX rebate excludes card-present UK/EEA |
| 15 | **Geographic / currency-settlement scope** | **GAP → `geo`** | HSBC RYC Overseas by network country codes (cl.5v). Citi FX rebate excludes card-present UK/EEA — cashback-card-spending-rebate-tnc cl.b. BOC: overseas = FCY-settled, excl. FCY settled in HKD — chill T&C cl.17. HSBC 1% fee on HKD txns outside HK / non-HK merchants — https://www.hsbc.com.hk/content/dam/hsbc/hk/docs/credit-cards/key-fact-statement.pdf |
| 16 | FX transaction fee | `fx_fee` | HSBC: 1.95% (incl. 1% scheme fee); UnionPay 1%; separate 1% charge on HKD-settled-overseas txns — KFS + https://www.hsbc.com.hk/content/dam/hsbc/hk/docs/ways-to-bank/bank-tariff/20250201-guide.pdf. Two fee variants → two `fx_fee` rows with geo scoping |
| 17 | **Targeted / invitation-only** | **GAP → `targeted`** | SC: "only applicable to selected cardholders" invited via push/SMS/email — https://av.sc.com/hk/content/docs/hk-500-fps-0920.pdf cl.2; Smart Card designated offer — https://av.sc.com/hk/edm/credit-cards/smartcard-1000-202109/en/index.html; instalment promo "Selected Customers only" — https://www.sc.com/hk/credit-cards/statement-instalment-plan/ |
| 18 | **Cardholder/account eligibility gate** | **GAP → `eligibility`** | Principal-only (DBS promos, AEON DAY). New customer = no card held in past 12 months (AEON welcome). Student exemption from HK$3,000 gate (MMPOWER). Relationship balance ≥HK$100k (SC Simply Cash welcome — https://www.sc.com/hk/credit-cards/simplycash/). Subscription/balance/payroll gates: Mox 2% behind Mox+ (prev. HK$250k balance; HK$25k payroll txn) — Mox Rewards Table + https://mox.com/features/mox-credit/ |
| 19 | Tiered/conditional rate above spend threshold | `min_spend` gate on elevated rate row | Citi PremierMiles (row 8), BOC Chill (row 7), Mox tiers (row 18). No new kind; **needs amount field** |
| 20 | Posting deadline | field `post_within_days` (or kind) | BOC Chill: must post within 7 days of transaction — chill_tnc_EN.pdf cl.3. MMPOWER: within 15 days to count for that month — everyday_tnc cl.2 |
| 21 | Mutually exclusive categories / precedence | `rate_terms.priority` or `exclusive_group` | MMPOWER fixed precedence 4a>4b>4c>4d — everyday_tnc cl.5. Mox: highest applicable rate only — Rewards Schedule cl.5. DBS Black promo void if enrolled in DBS$ scheme — BlackMC T&C cl.1 |
| 22 | Mission / nth-transaction rewards | **GAP → `mission`** (defer; text-only) | DBS Sub Club: 3rd/4th/5th mission per month → HK$10/20/30 — dbs.com.hk/personal/promotion/subscription |
| 23 | Banded/marginal rebate (rate on excess only) | GAP-lite (compute flag or text) | SC Pay: 3.5% on transfer amount *above* HK$40,000, capped HK$80,000/phase — scpay T&C cl.3 |
| 24 | Recurring day-of-month schedule | `period`/`event_dates` convention | AEON DAY every 10th of month, specific date list — promotion_10xbp_0324.html |
| 25 | Promo code at application | `registration_required` subtype (promo_code) | HSBC Red welcome 'HSBCRED' — product page |
| 26 | Combined principal+supplementary / cross-card aggregation | modeling note (not a kind) | HSBC RYC aggregates all cards under one HKID — RYC T&C cl.10. BOC combines main+supplementary — chill T&C cl.5 |
| 27 | Activity cadence (≥1 txn each month) | min_spend sub-field or text | Citi welcome offers — welcome-offers/tnc |
| 28 | Behavioural-history reward condition | GAP-lite (folds into `eligibility`) | DBS Sub Club dormant-spender bonus (no eligible txn Jan–May → extra HK$40) — Sub Club T&C |
| 29 | Dormant fine print: clawback, good-standing, rounding | stays in `text` | Universal (all issuers); BOC rounds to nearest dollar; HSBC carries RC remainder forward |

## (b) Recommended enum

```
cap                    — spend/reward ceilings (keep)
exclusion              — ineligible transaction types (keep)
fx_fee                 — currency-conversion fees (keep; multiple rows for
                         HKD-overseas vs FCY variants)
min_spend              — spend gates, incl. tier-upgrade gates (keep + add field)
registration_required  — opt-in mechanics incl. promo codes (keep)
channel                — online/physical/wallet/app/presentment (keep)
mcc                    — merchant-category-code scoping (keep)
quota            [NEW] — first-N registrants / FCFS reward pools
merchant_list    [NEW] — named-merchant whitelists (not MCC)
geo              [NEW] — country-code / currency-settlement scope
targeted         [NEW] — invitation-only offers
eligibility      [NEW] — principal-only, new-customer, student, balance,
                         subscription, payroll gates
```

Field additions: `terms.threshold_hkd` (or generalize `cap_hkd`→`amount_hkd`),
`terms.quota_n`, `terms.post_within_days`, `terms.register_by`,
`terms.anchor`+`terms.anchor_days` (rolling windows),
`rate_terms.priority` (precedence/exclusivity).
Watchlist, not enum yet: `mission`, banded/marginal compute flag,
recurring-day schedules.

## (c) Modeling answers

**Do promo rates expire at rate level? Yes — keep `effective_from/to` on rates.**
Promo uplifts exist as dated rates, not only as base+term: the Mox Card Rewards
Table carries a per-rate "Offer period (From…to…)" column
(mox.com/static/260227_Mox_Card_Rewards_Table.pdf); HSBC publishes rate/T&C
changes "with effect from 15 July 2026" (Red page); Citi Rewards extra-points
programme is "valid from 31 Oct 2024 until further notice" (open-ended
`effective_from`, null `to`); DBS Eminent requires annual re-registration per
programme year. Model uplift as a dated rate row attached to the card. Terms
keep independent windows — registration deadline (RYC: 31 Oct) ≠ spend window
(to 31 Dec) ≠ posting deadline.

**`period` values needed beyond `statement_month`:** `statement_cycle` (Citi),
`calendar_month` (HSBC Red, DBS Eminent, MMPOWER, BOC Chill), `promo_period`
(RYC, DBS Sub Club, SC Smart offer), `promo_phase` (SC Pay), `event_date`
(AEON DAY), `rolling_window` (all welcome offers; needs anchor +
days/months), `per_transaction` (per-txn gates), and `none` for uncapped.
Statement-cycle is a real, current Citi convention — keep it.
