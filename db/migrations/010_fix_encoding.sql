-- =====================================================================
-- 010: Korjaa väärin tallentuneet ääkköset (migraatio 009 Windowsin psql:llä)
--
-- Jos 009_environments.sql ajettiin Windowsissa psql:llä ennen kuin tiedostoon lisättiin
-- rivi SET client_encoding = 'UTF8', psql luki UTF-8-tiedoston WIN1252-merkistönä:
--   "sähköposti" -> "sÃ¤hkÃ¶posti", "–" -> "â€“"
-- Tämä migraatio palauttaa tekstit oikeiksi tulkitsemalla väärät merkit uudelleen.
-- Vain rivit, joissa on tyypillinen virhekuvio (Ã tai â€), muutetaan, joten oikein
-- tallentuneet tekstit (esim. Neon-tuotantokanta) eivät muutu.
-- Idempotentti: voi ajaa monta kertaa.
--
-- Ajo (Windows, PowerShell, LouhiAds-kansiossa):
--   psql -U postgres -d louhiads -f db\migrations\010_fix_encoding.sql
-- =====================================================================
SET client_encoding = 'UTF8';

BEGIN;

UPDATE environments
SET name        = CASE WHEN name ~ '(Ã|â€)' THEN convert_from(convert_to(name, 'WIN1252'), 'UTF8') ELSE name END,
    description = CASE WHEN description ~ '(Ã|â€)' THEN convert_from(convert_to(description, 'WIN1252'), 'UTF8') ELSE description END
WHERE name ~ '(Ã|â€)' OR description ~ '(Ã|â€)';

-- Viiteavain (ON UPDATE CASCADE) päivittää mainospaikkojen environment-sarakkeen yllä.
UPDATE placements
SET name  = CASE WHEN name ~ '(Ã|â€)' THEN convert_from(convert_to(name, 'WIN1252'), 'UTF8') ELSE name END,
    notes = CASE WHEN notes ~ '(Ã|â€)' THEN convert_from(convert_to(notes, 'WIN1252'), 'UTF8') ELSE notes END
WHERE name ~ '(Ã|â€)' OR notes ~ '(Ã|â€)';

COMMIT;
