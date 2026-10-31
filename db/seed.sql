-- =====================================================================
-- Louhi Ads – testidata kehitystä varten
-- Aja schema.sql:n jälkeen.
-- =====================================================================

SET client_encoding = 'UTF8';

-- Käyttäjä. Salasana asetetaan myöhemmin backendin kautta
-- ('!' = kirjautuminen estetty, kunnes oikea hash on asetettu).
INSERT INTO users (email, name, password_hash, role) VALUES
  ('johnny@louhi.fi', 'Johnny Kuoppala', '!', 'admin');

-- Mainostajat (luku 5)
INSERT INTO advertisers (name, website_url, status) VALUES
  ('SaaShop', 'https://www.saashop.fi/', 'active'),
  ('Getafix', 'https://www.getafix.fi/', 'active'),
  ('Pilvi',   'https://www.pilvi.fi/',   'active'),
  ('Goodi',   'https://www.goodi.fi/',   'active'),
  ('Louhi',   'https://www.louhi.fi/',   'active');

-- Ympäristöt (Ympäristöt-sivu). channel: web = verkkosivu, email = sähköposti
INSERT INTO environments (name, channel, description) VALUES
  ('Louhi Konsoli',        'web',   NULL),
  ('www',                  'web',   NULL),
  ('Domain Control Panel', 'web',   NULL),
  ('Tukiportaali',         'web',   NULL),
  ('cPanel',               'web',   NULL),
  ('LouhiDemo-sivusto',    'web',   'Demosivu (demopage/), jolla mainospaikkoja testataan.'),
  ('Uutiskirje',           'email', 'Louhen asiakasuutiskirje (sähköposti, 600 px leveä).');

-- Mainospaikat (luku 3)
INSERT INTO placements (name, code, environment, width, height, status) VALUES
  ('Louhi Konsoli – pääbanneri',     'louhi_console_main',    'Louhi Konsoli',          1200, 300, 'active'),
  ('Louhi.fi sivupalkki',            'louhi_website_sidebar', 'www',                     300, 600, 'active'),
  ('Domain Control Panel',           'louhi_domain_panel',    'Domain Control Panel',    728,  90, 'active'),
  ('Tukiportaali – banneri',         'louhi_support_banner',  'Tukiportaali',            728,  90, 'active'),
  ('cPanel',                         'louhi_cpanel',          'cPanel',                  468,  60, 'inactive'),
  -- Demosivun (demopage/) mainospaikat, ks. migrations/004_demopage_placements.sql
  ('Demo hero',                      'louhi_demo_hero',        'LouhiDemo-sivusto',      300, 600, 'active'),
  ('Demo banneri',                   'louhi_demo_banneri',     'LouhiDemo-sivusto',      728,  90, 'active'),
  ('Demo sivun loppu',               'louhi_demo_sivun_loppu', 'LouhiDemo-sivusto',      300, 250, 'active'),
  -- Uutiskirjedemon (newsletter/) mainospaikat, ks. migrations/009_environments.sql
  ('Uutiskirje – yläbanneri',        'louhi_uutiskirje_yla',     'Uutiskirje',           600, 200, 'active'),
  ('Uutiskirje – sisältömainos',     'louhi_uutiskirje_sisalto', 'Uutiskirje',           600, 300, 'active');

-- Kampanjat (vastaavat campaigns.html:n esimerkkirivejä)
INSERT INTO campaigns (advertiser_id, name, start_time, end_time, status, utm_campaign)
SELECT a.id, v.name, v.start_time::timestamptz, v.end_time::timestamptz, v.status, v.utm
FROM (VALUES
  ('SaaShop', 'SaaShop Pipedrive Q4',     '2026-10-01 00:00+03', '2026-12-31 23:59+02', 'active', 'saashop_pipedrive'),
  ('Pilvi',   'Pilvi Cloud -nosto',       '2026-09-01 00:00+03', '2026-09-30 23:59+03', 'active', 'pilvi_cloud'),
  ('Getafix', 'Getafix syyskampanja',     '2026-10-15 00:00+03', '2026-10-31 23:59+02', 'active', 'getafix_syys'),
  ('Louhi',   'Louhi cPanel -tiedote',    '2026-08-01 00:00+03', '2026-08-31 23:59+03', 'paused', 'louhi_cpanel'),
  ('Goodi',   'Goodi verkkosivu-banneri', NULL,                  NULL,                  'draft',  'goodi_banneri')
) AS v(advertiser, name, start_time, end_time, status, utm)
JOIN advertisers a ON a.name = v.advertiser;

-- Mainosaineistot (kuvat ovat paikkamerkkejä, korvataan oikeilla).
-- Mainos kuuluu mainostajalle; kampanja valitaan vasta sijoitukselle.
INSERT INTO creatives (advertiser_id, name, image_url, target_url, alt_text, width, height)
SELECT a.id, v.name, v.image_url, v.target_url, v.alt_text, v.w, v.h
FROM (VALUES
  ('SaaShop', 'Banneri A',   'https://placehold.co/1200x300/png?text=SaaShop+A', 'https://www.saashop.fi/', 'Tutustu SaaShopiin',     1200, 300),
  ('SaaShop', 'Banneri B',   'https://placehold.co/1200x300/png?text=SaaShop+B', 'https://www.saashop.fi/', 'Pipedrive SaaShopista',  1200, 300),
  ('SaaShop', 'Banneri C',   'https://placehold.co/728x90/png?text=SaaShop+C',   'https://www.saashop.fi/', 'SaaShop – ohjelmistot',   728,  90),
  ('Pilvi',   'Cloud 1',     'https://placehold.co/1200x300/png?text=Pilvi',     'https://www.pilvi.fi/',   'Pilvi Cloud',            1200, 300),
  ('Getafix', 'Syys 1',      'https://placehold.co/728x90/png?text=Getafix',     'https://www.getafix.fi/', 'Getafix syystarjous',     728,  90),
  ('Louhi',   'Tiedote',     'https://placehold.co/468x60/png?text=Louhi',       'https://www.louhi.fi/',   'Louhen tiedote',          468,  60),
  ('Goodi',   'Sivupalkki',  'https://placehold.co/300x600/png?text=Goodi',      'https://www.goodi.fi/',   'Goodi',                   300, 600),
  -- Mainos ilman kampanjaa: näkyy demosivulla omalla aikataululla
  ('Louhi',   'Louhi talon mainos', 'https://placehold.co/300x250/png?text=Louhi', 'https://www.louhi.fi/', 'Louhi – kotimaiset verkkopalvelut', 300, 250)
) AS v(advertiser, name, image_url, target_url, alt_text, w, h)
JOIN advertisers a ON a.name = v.advertiser;

-- Sijoitukset (placings): mainos + mainospaikka (+ valinnainen kampanja).
-- Kampanjan sijoitukset perivät kampanjan aikataulun. Painoarvo (priority, 0–100) on
-- mainoskohtainen: osuus paikan näytöistä = painoarvo / paikan painoarvojen summa.
INSERT INTO placings (advertiser_id, creative_id, campaign_id, placement_id,
                     weight, priority, start_time, end_time)
SELECT cr.advertiser_id, cr.id, c.id, p.id, 1,
       v.painoarvo,
       COALESCE(c.start_time, now() - interval '14 days'),
       c.end_time
FROM (VALUES
  ('Banneri A',          'SaaShop Pipedrive Q4',     'louhi_console_main',     60),
  ('Banneri B',          'SaaShop Pipedrive Q4',     'louhi_console_main',     40),
  ('Banneri C',          'SaaShop Pipedrive Q4',     'louhi_domain_panel',     50),
  ('Banneri C',          'SaaShop Pipedrive Q4',     'louhi_console_main',     20),
  ('Cloud 1',            'Pilvi Cloud -nosto',       'louhi_console_main',     50),
  ('Syys 1',             'Getafix syyskampanja',     'louhi_support_banner',   50),
  ('Tiedote',            'Louhi cPanel -tiedote',    'louhi_cpanel',           50),
  ('Sivupalkki',         'Goodi verkkosivu-banneri', 'louhi_website_sidebar',  50),
  ('Louhi talon mainos', NULL,                       'louhi_demo_sivun_loppu', 10),
  ('Louhi talon mainos', NULL,                       'louhi_demo_hero',        10)
) AS v(creative, campaign, placement, painoarvo)
JOIN creatives  cr ON cr.name = v.creative
JOIN placements p  ON p.code  = v.placement
LEFT JOIN campaigns c ON c.name = v.campaign;

-- Kampanjoiden sallitut mainospaikat: paikat, joissa kampanjalla on sijoituksia,
-- sekä Goodin luonnoskampanjalle lisäksi demosivun hero-paikka
INSERT INTO campaign_placements (campaign_id, placement_id)
SELECT DISTINCT campaign_id, placement_id FROM placings WHERE campaign_id IS NOT NULL;
INSERT INTO campaign_placements (campaign_id, placement_id)
SELECT c.id, p.id FROM campaigns c, placements p
WHERE c.name = 'Goodi verkkosivu-banneri' AND p.code = 'louhi_demo_hero';

-- ---------------------------------------------------------------------
-- Keinotekoiset näytöt ja klikkaukset raportoinnin testaamiseen:
-- jokaiselle sijoitukselle 150–400 näyttöä päivässä enintään 14 päivän ajalta,
-- kun sijoitus ja sen mahdollinen kampanja ovat olleet voimassa. CTR noin 1–2 %.
-- ---------------------------------------------------------------------
INSERT INTO impressions (placing_id, occurred_at)
SELECT pl.id, d.day + random() * interval '1 day'
FROM placings pl
LEFT JOIN campaigns c ON c.id = pl.campaign_id
CROSS JOIN generate_series(date_trunc('day', now()) - interval '14 days',
                           date_trunc('day', now()) - interval '1 day',
                           interval '1 day') AS d(day)
-- viittaus ulompiin sarakkeisiin pakottaa uuden satunnaisluvun jokaiselle riville
CROSS JOIN LATERAL generate_series(
    1, 150 + (random() * 250 + 0 * (pl.id + extract(day FROM d.day)))::int) AS n
WHERE d.day >= date_trunc('day', pl.start_time)
  AND (pl.end_time IS NULL OR d.day < pl.end_time)
  AND (pl.campaign_id IS NULL OR (c.start_time IS NOT NULL
       AND d.day >= date_trunc('day', c.start_time) AND d.day < c.end_time));

-- Klikki kuuluu näyttöön: noin 1,5 % näytöistä klikataan 5 sekunnin kuluttua
INSERT INTO clicks (impression_id, occurred_at)
SELECT id, occurred_at + interval '5 seconds'
FROM impressions
WHERE random() < 0.015;
