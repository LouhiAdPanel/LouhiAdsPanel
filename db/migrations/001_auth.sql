-- =====================================================================
-- Migraatio 001: kirjautuminen
-- Aja OLEMASSA OLEVAAN tietokantaan (ei poista dataa):
--   psql -U postgres -d louhiads -f db/migrations/001_auth.sql
-- Uusi asennus schema.sql:llä sisältää nämä jo valmiiksi.
--
-- Mitä tekee: lisää users-tauluun last_login_at-sarakkeen ja luo sessions-taulun
-- evästepohjaista kirjautumista varten (ks. schema.sql, taulu sessions).
-- Miksi: kantaan, joka on luotu ennen kirjautumisominaisuutta, nämä puuttuvat.
-- Idempotentti: IF NOT EXISTS -ehtojen ansiosta tiedoston voi ajaa uudelleen
-- turvallisesti; jo olemassa olevat sarakkeet, taulut ja indeksit ohitetaan.
-- =====================================================================
SET client_encoding = 'UTF8';

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Evästeessä on satunnainen tunniste, kantaan vain sen SHA-256-tiiviste.
-- ON DELETE CASCADE: käyttäjän poisto poistaa myös hänen sessionsa.
CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT        PRIMARY KEY,
    user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
