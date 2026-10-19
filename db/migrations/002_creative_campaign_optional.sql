-- =====================================================================
-- Migraatio 002: mainoksen kampanja valinnaiseksi
-- Aja OLEMASSA OLEVAAN tietokantaan (ei poista dataa):
--   psql -U postgres -d louhiads -f db/migrations/002_creative_campaign_optional.sql
--
-- Mitä tekee: creatives.campaign_id saa olla NULL, ja viiteavain vaihdetaan
-- ON DELETE CASCADE -> ON DELETE SET NULL.
-- Miksi: mainoksen voi luoda mainoskirjastoon ennen kuin sille on kampanjaa,
-- eikä kampanjan poisto saa hävittää mainoksia (ne jäävät "Ilman kampanjaa").
-- Idempotentti: DROP NOT NULL ei tee mitään, jos rajoitetta ei ole, ja viiteavain
-- poistetaan (IF EXISTS) ja luodaan aina uudelleen, joten ajon voi toistaa.
-- BEGIN/COMMIT: muutokset tehdään yhtenä transaktiona, jotta virhetilanteessa
-- taulu ei jää ilman viiteavainta.
-- =====================================================================
SET client_encoding = 'UTF8';

BEGIN;

-- Mainos voi olla ilman kampanjaa
ALTER TABLE creatives ALTER COLUMN campaign_id DROP NOT NULL;

-- Kampanjan poisto irrottaa mainokset (ennen: poisti ne)
ALTER TABLE creatives DROP CONSTRAINT IF EXISTS creatives_campaign_id_fkey;
ALTER TABLE creatives
  ADD CONSTRAINT creatives_campaign_id_fkey
  FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE SET NULL;

COMMIT;
