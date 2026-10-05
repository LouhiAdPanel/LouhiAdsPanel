-- =====================================================================
-- Migraatio 001: kirjautuminen
-- Aja OLEMASSA OLEVAAN tietokantaan (ei poista dataa):
--   psql -U postgres -d louhiads -f db/migrations/001_auth.sql
-- Uusi asennus schema.sql:llä sisältää nämä jo valmiiksi.
-- =====================================================================
SET client_encoding = 'UTF8';

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS sessions (
    token_hash  TEXT        PRIMARY KEY,
    user_id     INTEGER     NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
