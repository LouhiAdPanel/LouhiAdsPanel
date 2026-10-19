-- =====================================================================
-- Louhi Ads – tietokantaskeema (PostgreSQL 14+)
-- Pohjana: tekninen määrittely, luku 15 (minimitietomalli) ja tiimin
-- tietokantakaavio, jossa sijoitus (PLACING) yhdistää mainoksen mainospaikkaan.
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
DROP TABLE IF EXISTS clicks, impressions, targeting_rules, placings, campaign_placements,
                     creative_placements, creatives, campaigns, placements, advertisers,
                     sessions, users, media_files CASCADE;

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
-- Tietomalli lyhyesti
--   advertisers 1─* campaigns           (kampanja kuuluu mainostajalle)
--   campaigns *─* placements            (kampanjan sallitut mainospaikat)
--   advertisers 1─* creatives           (mainos kuuluu mainostajalle, kampanja EI pakollinen)
--   placings = sijoitus: mainos tietyssä mainospaikassa omalla painolla,
--             prioriteetilla, aikataululla ja tilalla. Kampanja on valinnainen.
--   placings 1─* impressions 1─* clicks  (klikki kuuluu siihen näyttöön, jota klikattiin)
-- Yhdistelmäavaimet (id, advertiser_id) varmistavat, että sijoituksen mainos ja
-- kampanja kuuluvat samalle mainostajalle kuin sijoitus.
-- ---------------------------------------------------------------------

-- ---------------------------------------------------------------------
-- Mainostajat (luku 5)
-- Yritys, jonka mainoksia näytetään. Nimi on yksilöllinen (UNIQUE).
-- status: active / inactive / suspended (keskeytetty, esim. maksamatta).
-- Vain aktiivisen mainostajan mainoksia jaetaan.
-- updated_at päivittyy triggerillä (ks. tiedoston loppu).
-- ---------------------------------------------------------------------
CREATE TABLE advertisers (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL UNIQUE,
    website_url TEXT,
    status      TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive', 'suspended')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Mainospaikat (luku 3)
-- code = placement ID, jota mainostagi käyttää (data-placement="...")
-- Mainospaikka = kohta sivustolla, johon mainos upotetaan.
-- code: yksilöllinen, vain pienet kirjaimet, numerot ja alaviiva (CHECK),
--       jotta se toimii turvallisesti HTML-attribuutissa ja URL:ssa.
--       Muodostetaan nimestä (backend/app/slug.py) eikä sitä muuteta jälkikäteen.
-- width/height: mainospaikan koko pikseleinä (CHECK > 0); kuva skaalataan tähän kokoon.
-- status: active / inactive / paused. Vain aktiivisessa paikassa jaetaan mainoksia.
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
                CHECK (status IN ('active', 'inactive', 'paused')),
    notes       TEXT,                          -- tekniset asetukset / huomiot
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------
-- Kampanjat (luku 6) – valinnainen tapa ryhmitellä mainostajan sijoituksia
-- "Odottaa alkamista" ja "Päättynyt" johdetaan päivämääristä
-- (ks. näkymä v_campaign_status), joten niitä ei tallenneta statukseen.
-- advertiser_id ON DELETE RESTRICT: mainostajaa ei voi poistaa, jos sillä on
--   kampanjoita (estää historian ja tilastojen katoamisen vahingossa).
-- Jos sijoituksella on kampanja, sijoitus näkyy vain kun kampanja on aktiivinen
-- ja voimassa (sijoituksen oman aikataulun lisäksi).
-- UNIQUE (id, advertiser_id): kohde sijoituksen yhdistelmäviiteavaimelle.
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
    CHECK (status <> 'active' OR (start_time IS NOT NULL AND end_time IS NOT NULL)),
    UNIQUE (id, advertiser_id)
);
CREATE INDEX idx_campaigns_advertiser ON campaigns(advertiser_id);

-- ---------------------------------------------------------------------
-- Kampanjan sallitut mainospaikat (monesta moneen)
-- Kampanjalomakkeella valitaan paikat, joissa kampanjan mainokset saavat näkyä.
-- Mainoslomakkeella kampanjan valinta rajaa mainospaikkavalinnan näihin, ja jakelu
-- näyttää kampanjan sijoituksen vain, jos paikka on yhä kampanjan sallittu paikka.
-- ON DELETE CASCADE: kampanjan tai paikan poisto poistaa linkkirivin.
-- ---------------------------------------------------------------------
CREATE TABLE campaign_placements (
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id)  ON DELETE CASCADE,
    placement_id INTEGER NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, placement_id)
);
CREATE INDEX idx_cp_placement ON campaign_placements(placement_id);

-- ---------------------------------------------------------------------
-- Mainosaineistot (luku 7) – MVP: JPG/PNG + kohde-URL
-- Mainos kuuluu mainostajalle. Kampanjaa ei tarvita: mainos yhdistetään
-- mainospaikkoihin sijoituksilla (placings).
-- width/height = kuvan koko. Kuva skaalataan näytettäessä mainospaikan kokoon,
-- joten koko voi poiketa paikan koosta.
-- width/height saavat olla NULL (esim. ulkoinen kuva-URL, jonka kokoa ei tiedetä).
-- image_url: '/media/<nimi>' (ks. media_files) tai ulkoinen osoite.
-- target_url: CHECK vaatii http(s)-osoitteen (~* = regex, kirjainkoko ei merkitse),
--             jotta klikkaus ei voi ohjata esim. javascript:-osoitteeseen.
-- UNIQUE (id, advertiser_id): kohde sijoituksen yhdistelmäviiteavaimelle.
-- ---------------------------------------------------------------------
CREATE TABLE creatives (
    id            INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    advertiser_id INTEGER     NOT NULL REFERENCES advertisers(id) ON DELETE RESTRICT,
    name          TEXT        NOT NULL,
    image_url     TEXT        NOT NULL,
    target_url    TEXT        NOT NULL CHECK (target_url ~* '^https?://'),
    alt_text      TEXT        NOT NULL DEFAULT '',
    width         INTEGER,
    height        INTEGER,
    status        TEXT        NOT NULL DEFAULT 'active'
                  CHECK (status IN ('active', 'inactive', 'paused')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (id, advertiser_id)
);
CREATE INDEX idx_creatives_advertiser ON creatives(advertiser_id);

-- ---------------------------------------------------------------------
-- Sijoitus (kaavion PLACING): mainos tietyssä mainospaikassa
-- Taulun nimi on monikossa (placings), koska PLACING on PostgreSQL:n varattu sana.
-- Yksi rivi = "tämä mainos näkyy tässä paikassa näillä ehdoilla".
--   weight   = painotettu näyttöjako saman prioriteetin sijoitusten kesken (0 = ei näytetä)
--   priority = suurempi voittaa, kun samassa paikassa on useita sijoituksia
--   start_time / end_time = sijoituksen oma aikataulu (end_time NULL = toistaiseksi)
--   status   = active / inactive / paused; mainoslomakkeelta poistettu paikka
--              merkitään inactive-tilaan (ei poisteta), jotta tilastot säilyvät
--   campaign_id = valinnainen kampanja (NULL = ilman kampanjaa)
-- Yhdistelmäviiteavaimet:
--   (creative_id, advertiser_id) -> creatives(id, advertiser_id): mainos on samalta
--     mainostajalta. ON UPDATE CASCADE: jos mainoksen mainostaja vaihdetaan, sijoitukset
--     seuraavat mukana. ON DELETE CASCADE: mainoksen poisto poistaa sijoitukset.
--   (campaign_id, advertiser_id) -> campaigns(id, advertiser_id): kampanja on samalta
--     mainostajalta. Kun campaign_id on NULL, ehtoa ei tarkisteta (MATCH SIMPLE).
--     Kampanjaa poistettaessa backend irrottaa sijoitukset ensin (routers/campaigns.py).
-- UNIQUE (creative_id, placement_id): sama mainos on samassa paikassa vain kerran.
-- ---------------------------------------------------------------------
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
-- Jakelu hakee "paikan sijoitukset", kampanjasivu "kampanjan sijoitukset"
CREATE INDEX idx_placing_placement ON placings(placement_id);
CREATE INDEX idx_placing_campaign  ON placings(campaign_id);

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
-- Säännöt kuuluvat sijoitukseen, joten sijoituksen poisto poistaa ne (CASCADE).
-- ---------------------------------------------------------------------
CREATE TABLE targeting_rules (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    placing_id  INTEGER NOT NULL REFERENCES placings(id) ON DELETE CASCADE,
    type        TEXT    NOT NULL,
    operator    TEXT    NOT NULL CHECK (operator IN ('eq', 'neq', 'in', 'not_in')),
    value       TEXT    NOT NULL
);
CREATE INDEX idx_targeting_placing ON targeting_rules(placing_id);

-- ---------------------------------------------------------------------
-- Näytöt ja klikkaukset (luvut 11, 12, 18)
-- Ei IP-osoitteita eikä käyttäjätunnisteita (tietosuoja, luku 18).
-- Yksi rivi = yksi näyttö / yksi klikkaus. BIGINT-id, koska rivejä kertyy paljon.
-- Näyttö viittaa sijoitukseen, josta mainostaja, mainos, kampanja ja paikka
-- saadaan. Klikki viittaa näyttöön, jota klikattiin (klikkiosoite sisältää
-- näytön id:n, ks. routers/serving.py).
-- ON DELETE CASCADE: sijoituksen (tai mainoksen/paikan) poisto poistaa tilastot.
-- Siksi mainoslomake ei poista sijoituksia vaan merkitsee ne inactive-tilaan.
-- ---------------------------------------------------------------------
CREATE TABLE impressions (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    placing_id   INTEGER     NOT NULL REFERENCES placings(id) ON DELETE CASCADE,
    occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_impressions_time    ON impressions(occurred_at);
CREATE INDEX idx_impressions_placing ON impressions(placing_id, occurred_at);

CREATE TABLE clicks (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    impression_id BIGINT      NOT NULL REFERENCES impressions(id) ON DELETE CASCADE,
    occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_clicks_time       ON clicks(occurred_at);
CREATE INDEX idx_clicks_impression ON clicks(impression_id);

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
CREATE TRIGGER trg_placing_updated     BEFORE UPDATE ON placings     FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------
-- Näkymä: kampanjan näytettävä tila hallintapaneeliin
-- active + ei vielä alkanut  -> 'pending'  (Odottaa alkamista)
-- active + päättynyt         -> 'ended'    (Päättynyt)
-- muuten tallennettu status
-- Tila lasketaan kyselyhetkellä now()-funktiolla, joten kampanja vaihtuu
-- 'pending' -> 'active' -> 'ended' itsestään ilman ajastettua päivitystä.
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
-- Yksi rivi per (päivä, sijoitus). Sijoituksen kautta mukana mainostaja,
-- mainos, kampanja (voi olla NULL) ja mainospaikka.
-- 1) imp laskee näytöt ja clk klikit sijoituksittain. Klikin sijoitus saadaan
--    näytön kautta. Päivä otetaan Suomen ajassa, jotta klo 00–03 tapahtumat
--    eivät mene edelliselle päivälle (UTC).
-- 2) FULL OUTER JOIN: mukana myös rivit, joilla on vain näyttöjä tai vain klikkejä.
-- 3) CTR % = 100 * klikit / näytöt. NULLIF estää jaon nollalla.
-- ---------------------------------------------------------------------
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
