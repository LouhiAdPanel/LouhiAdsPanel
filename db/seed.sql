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

-- Mainospaikat (luku 3)
INSERT INTO placements (name, code, environment, width, height, status) VALUES
  ('Louhi Konsoli – pääbanneri',     'louhi_console_main',    'Louhi Konsoli',          1200, 300, 'active'),
  ('Louhi.fi sivupalkki',            'louhi_website_sidebar', 'www',                     300, 600, 'active'),
  ('Domain Control Panel',           'louhi_domain_panel',    'Domain Control Panel',    728,  90, 'active'),
  ('Tukiportaali – banneri',         'louhi_support_banner',  'Tukiportaali',            728,  90, 'active'),
  ('cPanel',                         'louhi_cpanel',          'cPanel',                  468,  60, 'inactive');

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

-- Kampanjat <-> mainospaikat
INSERT INTO campaign_placements (campaign_id, placement_id)
SELECT c.id, p.id
FROM (VALUES
  ('SaaShop Pipedrive Q4',     'louhi_console_main'),
  ('SaaShop Pipedrive Q4',     'louhi_domain_panel'),
  ('Pilvi Cloud -nosto',       'louhi_console_main'),
  ('Getafix syyskampanja',     'louhi_support_banner'),
  ('Louhi cPanel -tiedote',    'louhi_cpanel'),
  ('Goodi verkkosivu-banneri', 'louhi_website_sidebar')
) AS v(campaign, placement)
JOIN campaigns  c ON c.name = v.campaign
JOIN placements p ON p.code = v.placement;

-- Mainosaineistot (kuvat ovat paikkamerkkejä, korvataan oikeilla)
INSERT INTO creatives (campaign_id, name, image_url, target_url, alt_text, width, height, weight)
SELECT c.id, v.name, v.image_url, v.target_url, v.alt_text, v.w, v.h, v.weight
FROM (VALUES
  ('SaaShop Pipedrive Q4',  'Banneri A', 'https://placehold.co/1200x300/png?text=SaaShop+A', 'https://www.saashop.fi/', 'Tutustu SaaShopiin',        1200, 300, 50),
  ('SaaShop Pipedrive Q4',  'Banneri B', 'https://placehold.co/1200x300/png?text=SaaShop+B', 'https://www.saashop.fi/', 'Pipedrive SaaShopista',     1200, 300, 30),
  ('SaaShop Pipedrive Q4',  'Banneri C', 'https://placehold.co/728x90/png?text=SaaShop+C',   'https://www.saashop.fi/', 'SaaShop – ohjelmistot',      728,  90, 20),
  ('Pilvi Cloud -nosto',    'Cloud 1',   'https://placehold.co/1200x300/png?text=Pilvi',     'https://www.pilvi.fi/',   'Pilvi Cloud',               1200, 300,  1),
  ('Getafix syyskampanja',  'Syys 1',    'https://placehold.co/728x90/png?text=Getafix',     'https://www.getafix.fi/', 'Getafix syystarjous',        728,  90,  1),
  ('Louhi cPanel -tiedote', 'Tiedote',   'https://placehold.co/468x60/png?text=Louhi',       'https://www.louhi.fi/',   'Louhen tiedote',             468,  60,  1),
  ('Goodi verkkosivu-banneri','Sivupalkki','https://placehold.co/300x600/png?text=Goodi',    'https://www.goodi.fi/',   'Goodi',                      300, 600,  1)
) AS v(campaign, name, image_url, target_url, alt_text, w, h, weight)
JOIN campaigns c ON c.name = v.campaign;

-- ---------------------------------------------------------------------
-- Keinotekoiset näytöt ja klikkaukset raportoinnin testaamiseen:
-- jokaiselle kampanjan aikaväliin osuvalle päivälle (enintään 14 pv
-- taaksepäin) 150–400 näyttöä per mainos+paikka, CTR noin 1–2 %.
-- ---------------------------------------------------------------------

INSERT INTO impressions (campaign_id, creative_id, placement_id, created_at)
SELECT cr.campaign_id, cr.id, cp.placement_id,
       d.day + random() * interval '1 day'
FROM creatives cr
JOIN campaigns c            ON c.id = cr.campaign_id
JOIN campaign_placements cp ON cp.campaign_id = c.id
CROSS JOIN generate_series(date_trunc('day', now()) - interval '14 days',
                           date_trunc('day', now()) - interval '1 day',
                           interval '1 day') AS d(day)
-- viittaus ulompiin sarakkeisiin pakottaa uuden satunnaisluvun jokaiselle riville
CROSS JOIN LATERAL generate_series(
    1, 150 + (random() * 250 + 0 * (cr.id + cp.placement_id + extract(day FROM d.day)))::int) AS n
WHERE c.start_time IS NOT NULL
  AND d.day >= date_trunc('day', c.start_time)
  AND d.day <  c.end_time;

INSERT INTO clicks (campaign_id, creative_id, placement_id, created_at)
SELECT campaign_id, creative_id, placement_id, created_at + interval '5 seconds'
FROM impressions
WHERE random() < 0.015;
