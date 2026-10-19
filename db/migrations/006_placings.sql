-- =====================================================================
-- 006: Sijoitukset (placings) – uusi tietomalli tiimin kaavion mukaan
--
-- Mitä muuttuu:
--   - Mainos kuuluu mainostajalle (creatives.advertiser_id), ei kampanjalle.
--   - Uusi taulu placings (kaavion PLACING; PLACING on PostgreSQL:n varattu
--     sana, siksi monikko): mainos + mainospaikka + valinnainen kampanja sekä
--     oma paino, prioriteetti, aikataulu ja tila.
--   - Näyttö viittaa sijoitukseen, klikki näyttöön.
--   - creative_placements poistuu (korvautuu placingsilla), samoin creatives.campaign_id
--     ja creatives.weight. campaign_placements säilyy kampanjan sallittuina paikkoina.
--   - Tiloihin lisätään 'suspended' (mainostaja) ja 'paused' (paikka, mainos).
--
-- Data siirtyy:
--   - Mainoksen mainostaja = sen kampanjan mainostaja. (Kampanjattomat mainokset
--     saavat mainostajaksi "Tuntematon mainostaja", jonka voi vaihtaa paneelissa.)
--   - Jokaisesta mainoksen valitusta mainospaikasta (005) tulee aktiivinen sijoitus
--     kampanjan aikataululla ja prioriteetilla ja mainoksen painolla.
--   - Vanhoille näytöille/klikeille, joiden mainos+paikka-paria ei ole valittuna,
--     luodaan inactive-sijoitus, jotta tilastot säilyvät.
--   - Klikki liitetään saman mainoksen ja paikan lähimpään aiempaan näyttöön.
--
-- Aja vain kerran, migraatioiden 004 ja 005 jälkeen. Kaikki tapahtuu yhdessä
-- transaktiossa: jos jokin vaihe epäonnistuu, mitään ei muuteta.
-- Vaatii, että sovellus päivitetään samaan aikaan (vanha koodi ei toimi tämän jälkeen).
-- =====================================================================
BEGIN;

DO $$
BEGIN
    IF to_regclass('public.placings') IS NOT NULL THEN
        RAISE EXCEPTION 'Migraatio 006 on jo ajettu (taulu placings on olemassa).';
    END IF;
    IF to_regclass('public.creative_placements') IS NULL THEN
        RAISE EXCEPTION 'Aja ensin migraatio 005_creative_placements.sql.';
    END IF;
    IF EXISTS (SELECT 1 FROM targeting_rules) THEN
        RAISE EXCEPTION 'targeting_rules-taulussa on rivejä; siirrä ne käsin ennen migraatiota.';
    END IF;
END $$;

DROP VIEW IF EXISTS v_daily_stats;

-- 1) Tilojen uudet arvot
ALTER TABLE advertisers DROP CONSTRAINT IF EXISTS advertisers_status_check,
    ADD CONSTRAINT advertisers_status_check CHECK (status IN ('active', 'inactive', 'suspended'));
ALTER TABLE placements  DROP CONSTRAINT IF EXISTS placements_status_check,
    ADD CONSTRAINT placements_status_check  CHECK (status IN ('active', 'inactive', 'paused'));
ALTER TABLE creatives   DROP CONSTRAINT IF EXISTS creatives_status_check,
    ADD CONSTRAINT creatives_status_check   CHECK (status IN ('active', 'inactive', 'paused'));

-- 2) Mainos kuuluu mainostajalle
ALTER TABLE creatives ADD COLUMN advertiser_id INTEGER REFERENCES advertisers(id) ON DELETE RESTRICT;
UPDATE creatives cr SET advertiser_id = c.advertiser_id
FROM campaigns c WHERE c.id = cr.campaign_id;
INSERT INTO advertisers (name, status)
SELECT 'Tuntematon mainostaja', 'inactive'
WHERE EXISTS (SELECT 1 FROM creatives WHERE advertiser_id IS NULL)
ON CONFLICT (name) DO NOTHING;
UPDATE creatives SET advertiser_id = (SELECT id FROM advertisers WHERE name = 'Tuntematon mainostaja')
WHERE advertiser_id IS NULL;
ALTER TABLE creatives ALTER COLUMN advertiser_id SET NOT NULL;
CREATE INDEX idx_creatives_advertiser ON creatives(advertiser_id);

-- Kohteet yhdistelmäviiteavaimille
ALTER TABLE creatives ADD CONSTRAINT creatives_id_advertiser_id_key UNIQUE (id, advertiser_id);
ALTER TABLE campaigns ADD CONSTRAINT campaigns_id_advertiser_id_key UNIQUE (id, advertiser_id);

-- 3) Sijoitukset
CREATE TABLE placings (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    advertiser_id INTEGER     NOT NULL,
    creative_id   INTEGER     NOT NULL,
    campaign_id   INTEGER,
    placement_id  INTEGER     NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
    weight        INTEGER     NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 100),
    priority      INTEGER     NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
    start_time    TIMESTAMPTZ NOT NULL DEFAULT now(),
    end_time      TIMESTAMPTZ,
    status        TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'inactive', 'paused')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_time IS NULL OR end_time > start_time),
    UNIQUE (creative_id, placement_id),
    FOREIGN KEY (creative_id, advertiser_id) REFERENCES creatives(id, advertiser_id)
        ON DELETE CASCADE ON UPDATE CASCADE,
    FOREIGN KEY (campaign_id, advertiser_id) REFERENCES campaigns(id, advertiser_id)
);
CREATE INDEX idx_placing_placement ON placings(placement_id);
CREATE INDEX idx_placing_campaign  ON placings(campaign_id);
CREATE TRIGGER trg_placing_updated BEFORE UPDATE ON placings
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 3a) Mainoksille valitut paikat -> aktiiviset sijoitukset
INSERT INTO placings (advertiser_id, creative_id, campaign_id, placement_id,
                      weight, priority, start_time, end_time, status, created_at)
SELECT cr.advertiser_id, cr.id, cr.campaign_id, x.placement_id,
       cr.weight, LEAST(GREATEST(COALESCE(c.priority, 0), 0), 100),
       COALESCE(c.start_time, cr.created_at), c.end_time, 'active', cr.created_at
FROM creative_placements x
JOIN creatives cr     ON cr.id = x.creative_id
LEFT JOIN campaigns c ON c.id = cr.campaign_id;

-- 3b) Tilastojen mainos+paikka-parit ilman sijoitusta -> inactive-sijoitukset
INSERT INTO placings (advertiser_id, creative_id, campaign_id, placement_id,
                      weight, priority, start_time, status)
SELECT cr.advertiser_id, t.creative_id,
       CASE WHEN c.advertiser_id = cr.advertiser_id THEN t.campaign_id END,
       t.placement_id, cr.weight, 0, t.first_at, 'inactive'
FROM (SELECT creative_id, placement_id, min(campaign_id) AS campaign_id, min(created_at) AS first_at
      FROM (SELECT creative_id, placement_id, campaign_id, created_at FROM impressions
            UNION ALL
            SELECT creative_id, placement_id, campaign_id, created_at FROM clicks) e
      GROUP BY creative_id, placement_id) t
JOIN creatives cr     ON cr.id = t.creative_id
LEFT JOIN campaigns c ON c.id = t.campaign_id
WHERE NOT EXISTS (SELECT 1 FROM placings pl
                  WHERE pl.creative_id = t.creative_id AND pl.placement_id = t.placement_id);

-- 4) Näytöt -> sijoitus
ALTER TABLE impressions ADD COLUMN placing_id INTEGER;
UPDATE impressions i SET placing_id = pl.id
FROM placings pl
WHERE pl.creative_id = i.creative_id AND pl.placement_id = i.placement_id;

-- 5) Klikit -> lähin aiempi saman mainoksen ja paikan näyttö (tai lähin ylipäätään)
ALTER TABLE clicks ADD COLUMN impression_id BIGINT;
UPDATE clicks k SET impression_id = (
    SELECT i.id FROM impressions i
    WHERE i.creative_id = k.creative_id AND i.placement_id = k.placement_id
    ORDER BY (i.created_at <= k.created_at) DESC,
             abs(extract(epoch FROM k.created_at - i.created_at))
    LIMIT 1);
-- Klikit, joilla ei ole yhtään näyttöä: luodaan näyttö klikin hetkelle
WITH ins AS (
    INSERT INTO impressions (campaign_id, creative_id, placement_id, created_at, placing_id)
    SELECT k.campaign_id, k.creative_id, k.placement_id, k.created_at, pl.id
    FROM clicks k
    JOIN placings pl ON pl.creative_id = k.creative_id AND pl.placement_id = k.placement_id
    WHERE k.impression_id IS NULL
    RETURNING id, creative_id, placement_id, created_at
)
UPDATE clicks k SET impression_id = ins.id
FROM ins
WHERE k.impression_id IS NULL AND ins.creative_id = k.creative_id
  AND ins.placement_id = k.placement_id AND ins.created_at = k.created_at;

-- 6) Vanhat sarakkeet pois, uudet pakollisiksi
ALTER TABLE impressions ALTER COLUMN placing_id SET NOT NULL,
    ADD CONSTRAINT impressions_placing_id_fkey FOREIGN KEY (placing_id)
        REFERENCES placings(id) ON DELETE CASCADE;
ALTER TABLE impressions RENAME COLUMN created_at TO occurred_at;
ALTER TABLE impressions DROP COLUMN campaign_id, DROP COLUMN creative_id, DROP COLUMN placement_id;
CREATE INDEX idx_impressions_placing ON impressions(placing_id, occurred_at);

ALTER TABLE clicks ALTER COLUMN impression_id SET NOT NULL,
    ADD CONSTRAINT clicks_impression_id_fkey FOREIGN KEY (impression_id)
        REFERENCES impressions(id) ON DELETE CASCADE;
ALTER TABLE clicks RENAME COLUMN created_at TO occurred_at;
ALTER TABLE clicks DROP COLUMN campaign_id, DROP COLUMN creative_id, DROP COLUMN placement_id;
CREATE INDEX idx_clicks_impression ON clicks(impression_id);

ALTER TABLE creatives DROP COLUMN campaign_id, DROP COLUMN weight;
DROP TABLE creative_placements;  -- campaign_placements säilyy: kampanjan sallitut paikat (ks. 007)
DROP INDEX IF EXISTS idx_campaigns_active;

-- 7) Kohdennussäännöt kuuluvat sijoitukseen (taulu on tyhjä, tarkistettu alussa)
DROP TABLE targeting_rules;
CREATE TABLE targeting_rules (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    placing_id  INTEGER NOT NULL REFERENCES placings(id) ON DELETE CASCADE,
    type        TEXT    NOT NULL,
    operator    TEXT    NOT NULL CHECK (operator IN ('eq', 'neq', 'in', 'not_in')),
    value       TEXT    NOT NULL
);
CREATE INDEX idx_targeting_placing ON targeting_rules(placing_id);

-- 8) Raporttinäkymä uuteen rakenteeseen (sama kuin schema.sql:ssä)
CREATE VIEW v_daily_stats AS
WITH imp AS (
    SELECT (occurred_at AT TIME ZONE 'Europe/Helsinki')::date AS day,
           placing_id, count(*) AS impressions
    FROM impressions GROUP BY 1, 2
), clk AS (
    SELECT (k.occurred_at AT TIME ZONE 'Europe/Helsinki')::date AS day,
           i.placing_id, count(*) AS clicks
    FROM clicks k JOIN impressions i ON i.id = k.impression_id
    GROUP BY 1, 2
), d AS (
    SELECT COALESCE(i.day, k.day)               AS day,
           COALESCE(i.placing_id, k.placing_id) AS placing_id,
           COALESCE(i.impressions, 0)           AS impressions,
           COALESCE(k.clicks, 0)                AS clicks
    FROM imp i
    FULL OUTER JOIN clk k ON i.day = k.day AND i.placing_id = k.placing_id
)
SELECT d.day, d.placing_id,
       pl.advertiser_id, pl.creative_id, pl.campaign_id, pl.placement_id,
       d.impressions, d.clicks,
       ROUND(100.0 * d.clicks / NULLIF(d.impressions, 0), 2) AS ctr_percent
FROM d
JOIN placings pl ON pl.id = d.placing_id;

COMMIT;
