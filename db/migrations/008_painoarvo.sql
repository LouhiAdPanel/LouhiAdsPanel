-- =====================================================================
-- 008: Painoarvo yhdistää painon ja prioriteetin (tiimin päätös)
--
-- Mainoksen näkyvyys määräytyy yhdestä luvusta, painoarvosta 0–100, joka tallennetaan
-- tietokantakaavion mukaiseen sarakkeeseen placings.priority. Mainoksen osuus paikan
-- näytöistä = painoarvo / paikan kaikkien painoarvojen summa (0 = ei näytetä).
-- Tauluihin ei tule rakennemuutoksia: weight-sarake jää käyttämättä (arvo 1), ja
-- campaigns.priority jää käyttämättä (kampanjalomakkeella ei enää ole prioriteettia).
--
-- Vanhat arvot muunnetaan:
--   Matala (priority alle 25)  -> painoarvo 10
--   Normaali (25–74)           -> painoarvo 50
--   Korkea (75–100)            -> painoarvo 100
--   kampanjaton mainos, jonka paino oli 0 (piilotettu) -> painoarvo 0 (pysyy piilossa)
--
-- Migraation voi ajaa turvallisesti uudelleen: sarakkeen kommentti merkitsee sen ajetuksi,
-- eikä toinen ajo muuta arvoja.
-- =====================================================================
BEGIN;

DO $$
BEGIN
    IF col_description('placings'::regclass,
           (SELECT attnum FROM pg_attribute WHERE attrelid = 'placings'::regclass AND attname = 'priority'))
       LIKE 'Painoarvo%' THEN
        RAISE NOTICE 'Migraatio 008 on jo ajettu, arvoja ei muuteta.';
    ELSE
        UPDATE placings SET
            priority = CASE
                WHEN campaign_id IS NULL AND weight = 0 THEN 0
                WHEN priority >= 75 THEN 100
                WHEN priority >= 25 THEN 50
                ELSE 10
            END,
            weight = 1;
    END IF;
END $$;

ALTER TABLE placings ALTER COLUMN priority SET DEFAULT 50;
COMMENT ON COLUMN placings.priority IS 'Painoarvo 0–100 (0 = ei näytetä); osuus näytöistä = painoarvo / paikan painoarvojen summa';

COMMIT;
