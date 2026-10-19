-- =====================================================================
-- Louhi Ads – tietokantaskeema (PostgreSQL 14+)
-- Pohjana: tekninen määrittely, luku 15 (minimitietomalli)
--
-- HUOM: Tiedosto pudottaa olemassa olevat taulut ensin, joten sen voi
-- ajaa kehitysvaiheessa uudelleen "puhtaalta pöydältä".
-- ÄLÄ aja tuotantokantaan.
--
-- Muutokset olemassa olevaan kantaan tehdään db/migrations/-kansion tiedostoilla.
-- Kun muutat tätä tiedostoa, tee samasta muutoksesta myös migraatio.
--
-- Yleiset ratkaisut:
-- - id: GENERATED ALWAYS AS IDENTITY = tietokanta antaa juoksevan numeron.
-- - Tilat ovat TEXT + CHECK (ei ENUM-tyyppiä), jolloin arvoja on helppo lisätä.
-- - Aikaleimat ovat TIMESTAMPTZ (aikavyöhykkeellinen), tallennetaan UTC:nä.
-- =====================================================================

SET client_encoding = 'UTF8';
SET client_min_messages = warning;

DROP VIEW  IF EXISTS v_campaign_status, v_daily_stats CASCADE;
DROP TABLE IF EXISTS clicks, impressions, targeting_rules, campaign_placements,
                     creatives, campaigns, placements, advertisers, sessions, users, media_files CASCADE;

-- ---------------------------------------------------------------------
-- Käyttäjät (luku 14: Admin ja Editor)
-- Paneelin kirjautuvat käyttäjät. role: admin = kaikki oikeudet,
-- editor = kampanjat, mainokset ja raportit. password_hash = salasanan
-- tiiviste (ei koskaan selväkielistä salasanaa). is_active = FALSE estää
-- kirjautumisen poistamatta käyttäjää.
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
-- (Jos kanta vuotaa, tiivisteillä ei voi kirjautua.)
-- ON DELETE CASCADE: käyttäjän poisto poistaa myös hänen sessionsa.
-- Indeksi user_id:lle nopeuttaa käyttäjän kaikkien sessioiden poistoa.
CREATE TABLE sessions (
    token_hash  TEXT        PRIMARY KEY,
    user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------
-- Mainostajat (luku 5)
-- Yritys, jonka kampanjoita näytetään. Nimi on yksilöllinen (UNIQUE).
-- updated_at päivittyy triggerillä (ks. tiedoston loppu).
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
-- Mainospaikka = kohta Louhen sivustolla, johon mainos upotetaan.
-- code: yksilöllinen, vain pienet kirjaimet, numerot ja alaviiva (CHECK),
--       jotta se toimii turvallisesti HTML-attribuutissa ja URL:ssa.
--       Muodostetaan nimestä (backend/app/slug.py) eikä sitä muuteta jälkikäteen.
-- width/height: mainoksen MAKSIMIkoko pikseleinä (CHECK > 0).
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
-- advertiser_id ON DELETE RESTRICT: mainostajaa ei voi poistaa, jos sillä on
--   kampanjoita (estää historian ja tilastojen katoamisen vahingossa).
-- priority: suurempi arvo voittaa, kun useampi kampanja osuu samaan paikkaan.
-- CHECK-rajoitteet: loppu alun jälkeen, ja aktiivisella on oltava molemmat päivät.
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
-- Osittainen indeksi (WHERE status = 'active'): mainosten jakelu hakee vain
-- aktiivisia kampanjoita, joiden aikaväli osuu nykyhetkeen. Indeksi pysyy pienenä.
CREATE INDEX idx_campaigns_active     ON campaigns(start_time, end_time) WHERE status = 'active';

-- ---------------------------------------------------------------------
-- Kampanja <-> mainospaikka (monesta moneen)
-- Kampanja voi näkyä monessa paikassa ja paikassa monta kampanjaa.
-- Yhdistelmäavain estää saman parin tuplarivit. ON DELETE CASCADE kummassakin:
-- jos kampanja tai paikka poistetaan, pelkkä linkkirivi on turha.
-- Lisäindeksi placement_id:lle, koska jakelu hakee "paikan kampanjat"
-- (pääavaimen indeksi alkaa campaign_id:llä eikä auta siihen).
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
-- width/height saavat olla NULL (esim. ulkoinen kuva-URL, jonka kokoa ei tiedetä).
-- image_url: '/media/<nimi>' (ks. media_files) tai ulkoinen osoite.
-- target_url: CHECK vaatii http(s)-osoitteen (~* = regex, kirjainkoko ei merkitse),
--             jotta klikkaus ei voi ohjata esim. javascript:-osoitteeseen.
-- weight 0–100: 0 = ei näytetä lainkaan.
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
-- Vain PNG ja JPEG (CHECK). width/height luetaan kuvasta latauksessa, joten
-- ne ovat luotettavampia kuin lomakkeelta tulevat arvot. bytes = tiedostokoko.
-- Ei viiteavainta creatives-tauluun: image_url on tekstiä, ja sama kuva voi
-- olla useammalla mainoksella.
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
-- Säännöt kuuluvat kampanjaan, joten kampanjan poisto poistaa ne (CASCADE).
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
-- Yksi rivi = yksi näyttö / yksi klikkaus. BIGINT-id, koska rivejä kertyy paljon.
-- campaign_id tallennetaan erikseen (vaikka mainoksesta sen voisi päätellä), koska
-- mainoksen kampanja voi myöhemmin vaihtua tai poistua; tilasto säilyttää tapahtumahetken.
-- ON DELETE CASCADE: poistetun kampanjan/mainoksen/paikan tilastot poistuvat
-- samalla. Siksi paneelissa kannattaa mieluummin arkistoida kuin poistaa.
-- Indeksit: created_at aikavälihakuihin, (campaign_id, created_at) kampanjaraportteihin.
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
-- BEFORE UPDATE -trigger asettaa updated_at = now() jokaisessa päivityksessä,
-- joten sovelluskoodin ei tarvitse muistaa tehdä sitä itse.
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
-- Tila lasketaan kyselyhetkellä now()-funktiolla, joten kampanja vaihtuu
-- 'pending' -> 'active' -> 'ended' itsestään ilman ajastettua päivitystä.
-- c.* + display_status: API lukee kampanjat tästä näkymästä.
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
-- Yksi rivi per (päivä, kampanja, mainos, mainospaikka).
-- 1) imp ja clk laskevat näytöt ja klikit erikseen ryhmiteltyinä. Päivä otetaan
--    Suomen ajassa, jotta klo 00–03 tapahtumat eivät mene edelliselle päivälle (UTC).
-- 2) FULL OUTER JOIN yhdistää ne niin, että mukana ovat myös rivit, joilla on vain
--    näyttöjä tai vain klikkejä; COALESCE täyttää puuttuvat avaimet ja nollat.
-- 3) CTR % = 100 * klikit / näytöt, kahden desimaalin tarkkuudella. NULLIF tekee
--    nollasta NULLin, jolloin ilman näyttöjä CTR on NULL eikä jako nollalla kaada kyselyä.
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
