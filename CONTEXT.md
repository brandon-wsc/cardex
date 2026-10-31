# Cardex

A remote source of structured Hong Kong credit-card facts for other agents.

## Language

**Caller**:
An agent that invokes Cardex tools. Cardex has no person using it directly.
_Avoid_: User, customer

**Card**:
A credit-card product issued by an issuer, addressed by `id`.
_Avoid_: Product, account, the caller's card

**Issuer**:
The institution that issues a card.
_Avoid_: Bank, provider

**Rate**:
One earning or rebate rule on a card.
_Avoid_: Reward, cashback, offer

**Term**:
A condition on a card or rate: a cap, an exclusion, or a validity window.
_Avoid_: Fine print, footnote

**Tag**:
A canonical spend class, such as dining, online, or overseas. Tags overlap; one spend can match several.
_Avoid_: Category, label

**Alias**:
A free-text name — a merchant, a nickname, an abbreviation — that maps to one or more tags or cards.
_Avoid_: Keyword, synonym

**Seed**:
The curated offline dataset that is loaded for lookup. Each value stays traceable to a public source.
_Avoid_: Scrape, dump, index

**Assumption**:
An input the caller states up front when it asks for a score. The score reports the assumptions it used.
_Avoid_: Default, guess

**Unknown exclusion**:
A term the score could not check. The caller decides what to do with it.
_Avoid_: Edge case, caveat
