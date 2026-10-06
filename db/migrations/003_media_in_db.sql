-- =====================================================================
-- Migraatio 003: mainoskuvat tietokantaan
-- Aja OLEMASSA OLEVAAN tietokantaan (ei poista dataa):
--   psql -U postgres -d louhiads -f db/migrations/003_media_in_db.sql
-- Aiemmin levylle (LouhiAds/media/) ladatut kuvat toimivat edelleen.
-- =====================================================================
SET client_encoding = 'UTF8';

CREATE TABLE IF NOT EXISTS media_files (
    name         TEXT        PRIMARY KEY,
    content_type TEXT        NOT NULL CHECK (content_type IN ('image/png', 'image/jpeg')),
    data         BYTEA       NOT NULL,
    width        INTEGER     NOT NULL CHECK (width  > 0),
    height       INTEGER     NOT NULL CHECK (height > 0),
    bytes        INTEGER     NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
