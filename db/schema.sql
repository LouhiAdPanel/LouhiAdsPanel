-- =====================================================================
-- Louhi Ads – tietokantaskeema (PostgreSQL 14+)
-- Pohjana: tekninen määrittely, luku 15 (minimitietomalli)
--
-- HUOM: Tiedosto pudottaa olemassa olevat taulut ensin, joten sen voi
-- ajaa kehitysvaiheessa uudelleen "puhtaalta pöydältä".
-- ÄLÄ aja tuotantokantaan.
-- =====================================================================

SET client_encoding = 'UTF8';
SET client_min_messages = warning;

DROP VIEW  IF EXISTS v_campaign_status, v_daily_stats CASCADE;
DROP TABLE IF EXISTS clicks, impressions, targeting_rules, campaign_placements,
                     creatives, campaigns, placements, advertisers, sessions, users, media_files CASCADE;

-- ---------------------------------------------------------------------
-- Käyttäjät (luku 14: Admin ja Editor)
-- ---------------------------------------------------------------------
CREATE TABLE users (
    id             INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email          TEXT        NOT NULL UNIQUE,
    name           TEXT        NOT NULL,
    password_hash  TEXT        NOT NULL,
    role           TEXT        NOT NULL DEFAULT 'editor'
                   CHECK (role IN ('admin', 'editor')),
    is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
    last_login_at  TIMESTAMPTZ,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Kirjautumissessiot. Selaimen evästeessä on satunnainen tunniste,
-- tietokantaan tallennetaan vain sen SHA-256-tiiviste.
CREATE TABLE sessions (
    token_hash  TEXT        PRIMARY KEY,
    user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------
-- Mainostajat (luku 5)
-- ---------------------------------------------------------------------
CREATE TABLE advertisers (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL UNIQUE,
    website_url TEXT,
    status      TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Mainospaikat (luku 3)
-- code = placement ID, jota mainostagi käyttää (data-placement="...")
-- ---------------------------------------------------------------------
CREATE TABLE placements (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL,
    code        TEXT        NOT NULL UNIQUE
                CHECK (code ~ '^[a-z0-9_]+$'),
    environment TEXT        NOT NULL,          -- esim. 'Louhi Konsoli', 'www'
    width       INTEGER     NOT NULL CHECK (width  > 0),
    height      INTEGER     NOT NULL CHECK (height > 0),
    status      TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
    notes       TEXT,                          -- tekniset asetukset / huomiot
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Kampanjat (luku 6)
-- "Odottaa alkamista" ja "Päättynyt" johdetaan päivämääristä
-- (ks. näkymä v_campaign_status), joten niitä ei tallenneta statukseen.
-- ---------------------------------------------------------------------
CREATE TABLE campaigns (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    advertiser_id INTEGER     NOT NULL REFERENCES advertisers(id) ON DELETE RESTRICT,
    name          TEXT        NOT NULL,
    start_time    TIMESTAMPTZ,
    end_time      TIMESTAMPTZ,
    priority      INTEGER     NOT NULL DEFAULT 0,
    status        TEXT        NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'active', 'paused', 'archived')),
    utm_campaign  TEXT,                        -- luku 12: UTM-parametrit
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (end_time IS NULL OR start_time IS NULL OR end_time > start_time),
    -- aktiivisella kampanjalla on oltava aikaväli
    CHECK (status <> 'active' OR (start_time IS NOT NULL AND end_time IS NOT NULL))
);
CREATE INDEX idx_campaigns_advertiser ON campaigns(advertiser_id);
CREATE INDEX idx_campaigns_active     ON campaigns(start_time, end_time) WHERE status = 'active';

-- ---------------------------------------------------------------------
-- Kampanja <-> mainospaikka (monesta moneen)
-- ---------------------------------------------------------------------
CREATE TABLE campaign_placements (
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id)  ON DELETE CASCADE,
    placement_id INTEGER NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, placement_id)
);
CREATE INDEX idx_cp_placement ON campaign_placements(placement_id);

-- ---------------------------------------------------------------------
-- Mainosaineistot (luku 7) – MVP: JPG/PNG + kohde-URL
-- weight = painotettu näyttöjako (luku 8). Tasajako = kaikilla sama paino.
-- width/height = mainoksen koko. Mainos näytetään vain mainospaikoissa, joiden
-- width/height (= maksimikoko) on vähintään yhtä suuri.
-- ---------------------------------------------------------------------
CREATE TABLE creatives (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    -- Kampanja on valinnainen: mainos voi odottaa mainoskirjastossa ilman kampanjaa.
    -- Kampanjan poisto ei poista mainosta, vaan irrottaa sen kampanjasta.
    campaign_id INTEGER     REFERENCES campaigns(id) ON DELETE SET NULL,
    name        TEXT        NOT NULL,
    image_url   TEXT        NOT NULL,
    target_url  TEXT        NOT NULL CHECK (target_url ~* '^https?://'),
    alt_text    TEXT        NOT NULL DEFAULT '',
    width       INTEGER,
    height      INTEGER,
    weight      INTEGER     NOT NULL DEFAULT 1 CHECK (weight BETWEEN 0 AND 100),
    status      TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_creatives_campaign ON creatives(campaign_id);

-- ---------------------------------------------------------------------
-- Ladatut mainoskuvat. Tallennetaan tietokantaan, jotta ne säilyvät myös
-- pilvipalvelimella, jonka levy tyhjenee uudelleenkäynnistyksessä.
-- creatives.image_url = '/media/' || name
-- ---------------------------------------------------------------------
CREATE TABLE media_files (
    name         TEXT        PRIMARY KEY,               -- satunnainen, esim. 3f9a…c2.png
    content_type TEXT        NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
    data         BYTEA       NOT NULL,
    width        INTEGER     NOT NULL CHECK (width  > 0),
    height       INTEGER     NOT NULL CHECK (height > 0),
    bytes        INTEGER     NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Kohdennussäännöt (luku 9) – valmiina myöhempää käyttöä varten
-- esim. type='segment', operator='eq', value='webhosting_customer'
-- ---------------------------------------------------------------------
CREATE TABLE targeting_rules (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    type        TEXT    NOT NULL,
    operator    TEXT    NOT NULL CHECK (operator IN ('eq', 'neq', 'in', 'not_in')),
    value       TEXT    NOT NULL
);
CREATE INDEX idx_targeting_campaign ON targeting_rules(campaign_id);

-- ---------------------------------------------------------------------
-- Näytöt ja klikkaukset (luvut 11, 12, 18)
-- Ei IP-osoitteita eikä käyttäjätunnisteita (tietosuoja, luku 18).
-- ---------------------------------------------------------------------
CREATE TABLE impressions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campaign_id  INTEGER     NOT NULL REFERENCES campaigns(id)  ON DELETE CASCADE,
    creative_id  INTEGER     NOT NULL REFERENCES creatives(id)  ON DELETE CASCADE,
    placement_id INTEGER     NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_impressions_time     ON impressions(created_at);
CREATE INDEX idx_impressions_campaign ON impressions(campaign_id, created_at);

CREATE TABLE clicks (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    campaign_id  INTEGER     NOT NULL REFERENCES campaigns(id)  ON DELETE CASCADE,
    creative_id  INTEGER     NOT NULL REFERENCES creatives(id)  ON DELETE CASCADE,
    placement_id INTEGER     NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clicks_time     ON clicks(created_at);
CREATE INDEX idx_clicks_campaign ON clicks(campaign_id, created_at);

-- ---------------------------------------------------------------------
-- updated_at päivittyy automaattisesti
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_advertisers_updated BEFORE UPDATE ON advertisers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_placements_updated  BEFORE UPDATE ON placements  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_campaigns_updated   BEFORE UPDATE ON campaigns   FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER trg_creatives_updated   BEFORE UPDATE ON creatives   FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Näkymä: kampanjan näytettävä tila hallintapaneeliin
-- active + ei vielä alkanut  -> 'pending'  (Odottaa alkamista)
-- active + päättynyt         -> 'ended'    (Päättynyt)
-- muuten tallennettu status
-- ---------------------------------------------------------------------
CREATE VIEW v_campaign_status AS
SELECT c.*,
       CASE
         WHEN c.status = 'active' AND c.start_time > now() THEN 'pending'
         WHEN c.status = 'active' AND c.end_time  <= now() THEN 'ended'
         ELSE c.status
       END AS display_status
FROM campaigns c;

-- ---------------------------------------------------------------------
-- Näkymä: päiväkohtainen raportti (luku 11) – pohja raportoinnille ja CSV:lle
-- ---------------------------------------------------------------------
CREATE VIEW v_daily_stats AS
WITH imp AS (
    SELECT (created_at AT TIME ZONE 'Europe/Helsinki')::date AS day,
           campaign_id, creative_id, placement_id, count(*) AS impressions
    FROM impressions GROUP BY 1, 2, 3, 4
), clk AS (
    SELECT (created_at AT TIME ZONE 'Europe/Helsinki')::date AS day,
           campaign_id, creative_id, placement_id, count(*) AS clicks
    FROM clicks GROUP BY 1, 2, 3, 4
)
SELECT COALESCE(i.day, k.day)                   AS day,
       COALESCE(i.campaign_id, k.campaign_id)   AS campaign_id,
       COALESCE(i.creative_id, k.creative_id)   AS creative_id,
       COALESCE(i.placement_id, k.placement_id) AS placement_id,
       COALESCE(i.impressions, 0)               AS impressions,
       COALESCE(k.clicks, 0)                    AS clicks,
       ROUND(100.0 * COALESCE(k.clicks, 0) / NULLIF(i.impressions, 0), 2) AS ctr_percent
FROM imp i
FULL OUTER JOIN clk k
  ON i.day = k.day AND i.campaign_id = k.campaign_id
 AND i.creative_id = k.creative_id AND i.placement_id = k.placement_id;
