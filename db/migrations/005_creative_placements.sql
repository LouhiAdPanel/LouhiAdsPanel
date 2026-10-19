-- =====================================================================
-- 005: Mainoksen mainospaikat (creative_placements)
--
-- Mainokselle valitaan nyt lisättäessä mainospaikat, joissa se saa näkyä
-- (vähintään yksi). Aiemmin mainos näkyi automaattisesti kaikissa kampanjansa
-- paikoissa, joihin se mahtui.
--
-- Olemassa olevat mainokset saavat valinnoikseen täsmälleen ne paikat, joissa
-- ne näkyivät tähän asti (kampanjan paikat, joihin mainos mahtuu), joten jakelu
-- ei muutu. Kampanjattomille mainoksille paikat valitaan seuraavalla muokkauksella.
--
-- Idempotentti: IF NOT EXISTS ja NOT EXISTS -> voi ajaa monta kertaa. Täyttö
-- koskee vain mainoksia, joilla ei vielä ole yhtään valittua paikkaa.
-- =====================================================================
CREATE TABLE IF NOT EXISTS creative_placements (
    creative_id  INTEGER NOT NULL REFERENCES creatives(id)  ON DELETE CASCADE,
    placement_id INTEGER NOT NULL REFERENCES placements(id) ON DELETE CASCADE,
    PRIMARY KEY (creative_id, placement_id)
);
CREATE INDEX IF NOT EXISTS idx_crp_placement ON creative_placements(placement_id);

INSERT INTO creative_placements (creative_id, placement_id)
SELECT cr.id, cp.placement_id
FROM creatives cr
JOIN campaign_placements cp ON cp.campaign_id = cr.campaign_id
JOIN placements p           ON p.id = cp.placement_id
WHERE (cr.width IS NULL OR cr.height IS NULL
       OR (cr.width <= p.width AND cr.height <= p.height))
  AND NOT EXISTS (SELECT 1 FROM creative_placements x WHERE x.creative_id = cr.id)
ON CONFLICT DO NOTHING;
