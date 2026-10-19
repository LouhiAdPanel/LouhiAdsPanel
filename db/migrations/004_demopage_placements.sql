-- =====================================================================
-- 004: Demosivun (demopage/index.html) kolme mainospaikkaa
--
-- Demosivu on esimerkkiasiakkaan verkkosivu, jolla testataan, miltä
-- mainokset näyttävät oikealla sivustolla. Sivulle on upotettu kolme
-- .louhi-ad-paikkaa; tämä migraatio luo niitä vastaavat mainospaikat.
-- Placement ID:t (code) on muodostettu samalla säännöllä kuin
-- hallintapaneelissa (backend/app/slug.py), nimestä.
--
-- Mainos näkyy paikassa, kun aktiivinen kampanja liitetään siihen
-- (Kampanjat-sivu → Mainospaikat) ja kampanjassa on paikkaan mahtuva mainos.
--
-- Idempotentti: ON CONFLICT (code) DO NOTHING -> voi ajaa monta kertaa,
-- jo olemassa olevaa mainospaikkaa ei muuteta.
-- =====================================================================
INSERT INTO placements (name, code, environment, width, height, status, notes) VALUES
  ('Demo hero',         'louhi_demo_hero',        'LouhiDemo-sivusto', 300, 600, 'active',
   'Demosivun hero-osion oikea palsta'),
  ('Demo banneri',      'louhi_demo_banneri',     'LouhiDemo-sivusto', 728,  90, 'active',
   'Demosivun vaakabanneri palveluiden ja tilastojen välissä'),
  ('Demo sivun loppu',  'louhi_demo_sivun_loppu', 'LouhiDemo-sivusto', 300, 250, 'active',
   'Demosivun lopun laatikko')
ON CONFLICT (code) DO NOTHING;
