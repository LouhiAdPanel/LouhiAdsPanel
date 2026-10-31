-- =====================================================================
-- 009: Ympäristöt omaan tauluun (environments) + uutiskirjeen ympäristö
--
-- Ympäristö = palvelu tai kanava, jossa mainospaikat ovat (esim. Louhi Konsoli,
-- www, Uutiskirje). Aiemmin ympäristöt olivat kiinteä lista lomakkeen koodissa;
-- nyt admin hallitsee niitä Ympäristöt-sivulla (environments.html).
--
-- Rakenne:
--   environments(id, name UNIQUE, channel, description)
--     channel = 'web'   -> mainokset verkkosivulla mainostagilla (louhi-ads.js)
--               'email' -> mainokset sähköpostissa kuva+linkki-upotuksella
--                          (/api/v1/email/..., ks. routers/serving.py)
--   placements.environment säilyy tekstinä (ei muutoksia sovelluksen muuhun koodiin),
--   mutta siitä tulee viiteavain environments(name):
--     ON UPDATE CASCADE  -> ympäristön nimen muutos päivittyy sen mainospaikoille
--     ON DELETE RESTRICT -> käytössä olevaa ympäristöä ei voi poistaa
--
-- Lisäksi luodaan uutiskirjeen ympäristö ja sille kaksi mainospaikkaa, joita
-- uutiskirjedemo (newsletter/) käyttää.
--
-- Idempotentti: voi ajaa monta kertaa. Aja migraation 008 jälkeen.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS environments (
    id          INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    name        TEXT        NOT NULL UNIQUE,
    channel     TEXT        NOT NULL DEFAULT 'web' CHECK (channel IN ('web', 'email')),
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_environments_updated ON environments;
CREATE TRIGGER trg_environments_updated BEFORE UPDATE ON environments
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Aiemman lomakkeen kiinteät ympäristöt + kaikki mainospaikoilla jo käytetyt nimet
INSERT INTO environments (name)
SELECT name FROM (VALUES ('Louhi Konsoli'), ('www'), ('Domain Control Panel'),
                         ('Tukiportaali'), ('cPanel')) AS v(name)
UNION
SELECT DISTINCT environment FROM placements
ON CONFLICT (name) DO NOTHING;

INSERT INTO environments (name, channel, description)
VALUES ('Uutiskirje', 'email', 'Louhen asiakasuutiskirje (sähköposti, 600 px leveä).')
ON CONFLICT (name) DO NOTHING;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'placements_environment_fkey') THEN
        ALTER TABLE placements ADD CONSTRAINT placements_environment_fkey
            FOREIGN KEY (environment) REFERENCES environments(name)
            ON UPDATE CASCADE ON DELETE RESTRICT;
    END IF;
END $$;

-- Uutiskirjeen mainospaikat (sähköpostin sisältöleveys 600 px)
INSERT INTO placements (name, code, environment, width, height, status, notes) VALUES
  ('Uutiskirje – yläbanneri',   'louhi_uutiskirje_yla',     'Uutiskirje', 600, 200, 'active',
   'Uutiskirjeen otsikon alla. Sähköpostiupotus, ks. Upotuskoodi.'),
  ('Uutiskirje – sisältömainos', 'louhi_uutiskirje_sisalto', 'Uutiskirje', 600, 300, 'active',
   'Uutiskirjeen artikkelien välissä. Sähköpostiupotus, ks. Upotuskoodi.')
ON CONFLICT (code) DO NOTHING;

COMMIT;
