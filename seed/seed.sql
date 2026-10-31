-- Synthetic seed for the Cardex prototype. Every number and source_url below
-- is invented for the tool shape — NOT issuer terms (provenance.illustrative).
-- Idempotent: clears and re-inserts the fixture rows.

DELETE FROM rate_terms;
DELETE FROM rate_tags;
DELETE FROM alias_tags;
DELETE FROM alias_cards;
DELETE FROM aliases;
DELETE FROM terms;
DELETE FROM rates;
DELETE FROM tags;
DELETE FROM cards;
DELETE FROM reports;
DELETE FROM meta;

INSERT INTO meta (key, value) VALUES ('seed_as_of', '2026-11-01');

INSERT INTO cards (id, name, issuer, network) VALUES
  ('card_hsbc_red',   'HSBC Red Credit Card',            'HSBC',               'visa'),
  ('card_citi_cash',  'Citi Cash Back Card',             'Citi',               'mastercard'),
  ('card_scb_simply', 'Standard Chartered Simply Cash',  'Standard Chartered', 'mastercard'),
  ('card_aeon',       'AEON Mastercard',                 'AEON',               'mastercard');

INSERT INTO tags (id, label, kind) VALUES
  ('dining',      'Dining',      'category'),
  ('supermarket', 'Supermarket', 'category'),
  ('online',      'Online',      'channel'),
  ('overseas',    'Overseas',    'channel');

INSERT INTO terms (id, card_id, kind, text, source_url, last_verified_at,
                   effective_from, effective_to, cap_hkd, period, exclusion_key) VALUES
  ('term_hsbc_dining_cap', 'card_hsbc_red', 'cap',
   'Illustrative dining rebate cap of HK$300 per statement month.',
   'https://example.invalid/cardex-seed/hsbc-red-terms', '2026-10-01',
   '2026-01-01', NULL, 300, 'statement_month', NULL),
  ('term_hsbc_octopus', 'card_hsbc_red', 'exclusion',
   'Excludes Octopus top-up.',
   'https://example.invalid/cardex-seed/hsbc-red-terms', '2026-10-01',
   '2026-01-01', NULL, NULL, NULL, 'octopus_topup'),
  ('term_citi_super_cap', 'card_citi_cash', 'cap',
   'Illustrative supermarket rebate cap of HK$200 per statement month.',
   'https://example.invalid/cardex-seed/citi-cash-back-terms', '2026-10-01',
   '2026-01-01', NULL, 200, 'statement_month', NULL),
  ('term_citi_fx_fee', 'card_citi_cash', 'fx_fee',
   'Illustrative foreign-currency fee of about 1.95% on non-HKD spend.',
   'https://example.invalid/cardex-seed/citi-cash-back-terms', '2026-10-01',
   '2026-01-01', NULL, NULL, NULL, NULL),
  ('term_citi_expired_cap', 'card_citi_cash', 'cap',
   'Illustrative expired promo cap of HK$100, ended 2026-03-31.',
   'https://example.invalid/cardex-seed/citi-cash-back-terms', '2026-04-15',
   '2026-01-01', '2026-03-31', 100, 'promo_window', NULL),
  ('term_aeon_online_cap', 'card_aeon', 'cap',
   'Illustrative online rebate cap of HK$150 per statement month.',
   'https://example.invalid/cardex-seed/aeon-mastercard-terms', '2026-10-01',
   '2026-01-01', NULL, 150, 'statement_month', NULL);

INSERT INTO rates (id, card_id, kind, value, unit, source_url, last_verified_at) VALUES
  ('rate_hsbc_dining',   'card_hsbc_red',   'rebate_percent', 8, 'percent',
   'https://example.invalid/cardex-seed/hsbc-red-terms', '2026-10-01'),
  ('rate_hsbc_online',   'card_hsbc_red',   'rebate_percent', 4, 'percent',
   'https://example.invalid/cardex-seed/hsbc-red-terms', '2026-10-01'),
  ('rate_citi_super',    'card_citi_cash',  'rebate_percent', 6, 'percent',
   'https://example.invalid/cardex-seed/citi-cash-back-terms', '2026-10-01'),
  ('rate_citi_overseas', 'card_citi_cash',  'rebate_percent', 3, 'percent',
   'https://example.invalid/cardex-seed/citi-cash-back-terms', '2026-10-01'),
  ('rate_scb_overseas',  'card_scb_simply', 'points', 1, 'points_per_hkd',
   'https://example.invalid/cardex-seed/scb-simply-terms', '2026-10-01'),
  ('rate_aeon_dining',   'card_aeon',       'rebate_percent', 3, 'percent',
   'https://example.invalid/cardex-seed/aeon-mastercard-terms', '2026-10-01'),
  ('rate_aeon_online',   'card_aeon',       'rebate_percent', 5, 'percent',
   'https://example.invalid/cardex-seed/aeon-mastercard-terms', '2026-10-01');

INSERT INTO rate_tags (rate_id, tag_id) VALUES
  ('rate_hsbc_dining',   'dining'),
  ('rate_hsbc_online',   'online'),
  ('rate_citi_super',    'supermarket'),
  ('rate_citi_overseas', 'overseas'),
  ('rate_scb_overseas',  'overseas'),
  ('rate_aeon_dining',   'dining'),
  ('rate_aeon_online',   'online');

INSERT INTO rate_terms (rate_id, term_id) VALUES
  ('rate_hsbc_dining',   'term_hsbc_dining_cap'),
  ('rate_hsbc_dining',   'term_hsbc_octopus'),
  ('rate_citi_super',    'term_citi_super_cap'),
  ('rate_citi_overseas', 'term_citi_fx_fee'),
  ('rate_citi_overseas', 'term_citi_expired_cap'),
  ('rate_aeon_online',   'term_aeon_online_cap');

INSERT INTO aliases (text) VALUES
  ('茶餐廳'),
  ('cha chaan teng'),
  ('淘寶'),
  ('taobao'),
  ('紅卡'),
  ('hsbc red'),
  ('惠康'),
  ('wellcome'),
  ('海外');

INSERT INTO alias_tags (alias_text, tag_id) VALUES
  ('茶餐廳',          'dining'),
  ('cha chaan teng', 'dining'),
  ('淘寶',            'online'),
  ('taobao',         'online'),
  ('惠康',            'supermarket'),
  ('wellcome',       'supermarket'),
  ('海外',            'overseas');

INSERT INTO alias_cards (alias_text, card_id) VALUES
  ('紅卡',      'card_hsbc_red'),
  ('hsbc red', 'card_hsbc_red');
