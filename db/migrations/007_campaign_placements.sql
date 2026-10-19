-- =====================================================================
-- 007: Kampanjan sallitut mainospaikat (campaign_placements)
--
-- Kampanjalomakkeella valitaan mainospaikat, joissa kampanjan mainokset saavat
-- näkyä. Mainoksen kampanjasijoitukset rajataan näihin paikkoihin, ja jakelu
-- näyttää kampanjan sijoituksen vain sallitussa paikassa.
--
-- Jos taulu on jo olemassa (migraatio 006 säilytti sen), sitä ei luoda uudelleen.
-- Lisäksi jokaisen kampanjan nykyisten sijoitusten paikat merkitään sallituiksi,
-- jotta yksikään käytössä oleva sijoitus ei lakkaa näkymästä.
-- Idempotentti: voi ajaa monta kertaa. Aja migraation 006 jälkeen.
-- =====================================================================
CREATE TABLE IF NOT EXISTS campaign_placements (
    campaign_id  INTEGER NOT NULL REFERENCES campaigns(id)  ON DELETE CASCADE,
    placement_id INTEGER NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
    PRIMARY KEY (campaign_id, placement_id)
);
CREATE INDEX IF NOT EXISTS idx_cp_placement ON campaign_placements(placement_id);

INSERT INTO campaign_placements (campaign_id, placement_id)
SELECT DISTINCT campaign_id, placement_id
FROM placings
WHERE campaign_id IS NOT NULL AND status <> 'inactive'
ON CONFLICT DO NOTHING;
