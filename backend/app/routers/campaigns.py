"""Kampanjat – rajapinta hallintapaneelin Kampanjat-sivulle (campaigns.html).

Endpointit (polun /api/campaigns alla):
  GET    /api/campaigns               -> kampanjalista, suodatus tilalla/mainostajalla/nimellä
  GET    /api/campaigns/{id}          -> yksi kampanja
  POST   /api/campaigns               -> uusi kampanja + sen mainospaikat
  PUT    /api/campaigns/{id}          -> kampanjan ja sen mainospaikkojen päivitys
  PATCH  /api/campaigns/{id}/status   -> pelkän tilan vaihto (aktivointi/pysäytys/arkistointi)
  DELETE /api/campaigns/{id}          -> kampanjan poisto

Oikeudet: kaikki kirjautuneet (admin ja editor); main.py lisää kirjautumisvaatimuksen.

Liittyy: kampanja kuuluu mainostajalle (advertisers) ja näytetään valituissa
mainospaikoissa (liitostaulu campaign_placements, monta-moneen). Kampanjan mainokset
ovat creatives-taulussa. Mainosten jakelu (serving.py) näyttää vain aktiivisten,
käynnissä olevien kampanjoiden mainoksia.
"""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import delete_row, get_conn, insert_row, update_row
from ..schemas import CampaignIn, CampaignStatusIn

router = APIRouter(prefix="/api/campaigns", tags=["Kampanjat"])

# display_status: draft / active / paused / archived / pending (odottaa alkamista) / ended
# (Tallennettu status on draft/active/paused/archived; näkymä v_campaign_status johtaa
# siitä ja päivämääristä näyttötilan: aktiivinen mutta ei vielä alkanut = pending,
# aktiivinen mutta päättynyt = ended.)
#
# Kampanjalistan kysely. Yksi rivi per kampanja, mukana:
#   - advertiser_name: mainostajan nimi (JOIN advertisers)
#   - placements: kampanjan mainospaikat JSON-listana [{id, name, code}, ...].
#     json_agg kokoaa monta liitosriviä yhdeksi listaksi; FILTER pudottaa pois rivin,
#     joka syntyy LEFT JOINista, kun paikkoja ei ole, ja COALESCE antaa silloin '[]'.
#   - creative_count: kampanjan mainosten määrä
#   - unfit_creative_count: mainokset, jotka ovat liian suuria kaikkiin kampanjan
#     paikkoihin (näytetään paneelissa varoituksena)
# WHERE-ehdot ovat valinnaisia suodattimia: "(%(x)s IS NULL OR ...)" = jos parametri on
# None, ehto ei rajaa mitään. Näin samalla kyselyllä haetaan lista ja yksittäinen rivi.
# ::int / ::text kertovat PostgreSQL:lle parametrin tyypin, kun arvo on NULL.
# ILIKE = kirjainkoosta riippumaton haku; '%%' on psycopgissa escapattu %-jokerimerkki.
# GROUP BY luettelee sarakkeet, koska näkymän c.* ei ole taulu (pääavain ei riitä).
LIST_SQL = """
SELECT c.*,
       a.name AS advertiser_name,
       COALESCE(
         json_agg(json_build_object('id', p.id, 'name', p.name, 'code', p.code)
                  ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL),
         '[]') AS placements,
       (SELECT count(*) FROM creatives cr WHERE cr.campaign_id = c.id) AS creative_count,
       -- Mainokset, jotka eivät mahdu yhteenkään kampanjan mainospaikkaan (eivät näy missään)
       (SELECT count(*) FROM creatives cr
         WHERE cr.campaign_id = c.id AND cr.width IS NOT NULL AND cr.height IS NOT NULL
           AND EXISTS (SELECT 1 FROM campaign_placements x WHERE x.campaign_id = c.id)
           AND NOT EXISTS (SELECT 1 FROM campaign_placements x JOIN placements p2 ON p2.id = x.placement_id
                            WHERE x.campaign_id = c.id AND cr.width <= p2.width AND cr.height <= p2.height)
       ) AS unfit_creative_count
FROM v_campaign_status c
JOIN advertisers a                 ON a.id = c.advertiser_id
LEFT JOIN campaign_placements cp   ON cp.campaign_id = c.id
LEFT JOIN placements p             ON p.id = cp.placement_id
WHERE (%(id)s::int            IS NULL OR c.id = %(id)s)
  AND (%(status)s::text       IS NULL OR c.display_status = %(status)s)
  AND (%(advertiser_id)s::int IS NULL OR c.advertiser_id = %(advertiser_id)s)
  AND (%(q)s::text            IS NULL OR c.name ILIKE '%%' || %(q)s || '%%')
GROUP BY c.id, c.advertiser_id, c.name, c.start_time, c.end_time, c.priority, c.status,
         c.utm_campaign, c.created_at, c.updated_at, c.display_status, a.name
ORDER BY c.start_time DESC NULLS LAST, c.name
"""

DisplayStatus = Literal["draft", "active", "paused", "archived", "pending", "ended"]


def _fetch(conn, **filters):
    """Ajaa LIST_SQL:n. Antamattomat suodattimet ovat None (= ei rajausta)."""
    params = {"id": None, "status": None, "advertiser_id": None, "q": None, **filters}
    return conn.execute(LIST_SQL, params).fetchall()


def _set_placements(conn, campaign_id: int, placement_ids: list[int]):
    """Asettaa kampanjan mainospaikat: vanhat liitokset poistetaan ja uudet lisätään.

    Sama transaktio kuin kampanjan tallennus, joten virheessä kumpikaan ei jää voimaan.
    Olematon placement_id -> ForeignKeyViolation -> 409 (main.py).
    """
    conn.execute("DELETE FROM campaign_placements WHERE campaign_id = %s", [campaign_id])
    if placement_ids:
        # unnest purkaa id-taulukon riveiksi, jolloin kaikki lisätään yhdellä kyselyllä.
        # set() poistaa tuplat; ON CONFLICT DO NOTHING on lisävarmistus.
        conn.execute(
            """INSERT INTO campaign_placements (campaign_id, placement_id)
               SELECT %s, unnest(%s::int[]) ON CONFLICT DO NOTHING""",
            [campaign_id, list(set(placement_ids))],
        )


def _get_or_404(conn, campaign_id: int):
    """Hakee yhden kampanjan samassa muodossa kuin listassa, tai nostaa 404:n."""
    rows = _fetch(conn, id=campaign_id)
    if not rows:
        raise HTTPException(404, "Kampanjaa ei löytynyt.")
    return rows[0]


@router.get("")
def list_campaigns(
    status: DisplayStatus | None = None,
    advertiser_id: int | None = None,
    q: str | None = Query(default=None, description="Haku kampanjan nimellä"),
    conn=Depends(get_conn),
):
    """GET /api/campaigns – kampanjalista uusimmat (alkamispäivä) ensin.

    Valinnaiset query-parametrit: status (näyttötila), advertiser_id, q (nimihaku).
    Esim. /api/campaigns?status=active&q=kevät. Virheellinen status -> 422.
    """
    return _fetch(conn, status=status, advertiser_id=advertiser_id, q=q or None)


@router.get("/{campaign_id}")
def get_campaign(campaign_id: int, conn=Depends(get_conn)):
    """GET /api/campaigns/{campaign_id} – yksi kampanja. Virheet: 404 ei löydy."""
    return _get_or_404(conn, campaign_id)


@router.post("", status_code=201)
def create_campaign(body: CampaignIn, conn=Depends(get_conn)):
    """POST /api/campaigns – luo kampanjan ja liittää sen mainospaikkoihin.

    placement_ids ei ole campaigns-taulun sarake, joten se erotetaan ja tallennetaan
    liitostauluun. Palauttaa kampanjan listamuodossa (201).
    Virheet: 422 virheellinen runko (esim. aktiivinen ilman päivämääriä, CampaignIn),
    409 olematon mainostaja tai mainospaikka.
    """
    data = body.model_dump(exclude={"placement_ids"})
    row = insert_row(conn, "campaigns", data)
    _set_placements(conn, row["id"], body.placement_ids)
    return _get_or_404(conn, row["id"])


@router.put("/{campaign_id}")
def update_campaign(campaign_id: int, body: CampaignIn, conn=Depends(get_conn)):
    """PUT /api/campaigns/{campaign_id} – korvaa kampanjan tiedot ja mainospaikat.

    Palauttaa päivitetyn kampanjan. Virheet: 404 ei löydy, muuten kuten luonnissa.
    """
    data = body.model_dump(exclude={"placement_ids"})
    if not update_row(conn, "campaigns", campaign_id, data):
        raise HTTPException(404, "Kampanjaa ei löytynyt.")
    _set_placements(conn, campaign_id, body.placement_ids)
    return _get_or_404(conn, campaign_id)


@router.patch("/{campaign_id}/status")
def set_campaign_status(campaign_id: int, body: CampaignStatusIn, conn=Depends(get_conn)):
    """PATCH /api/campaigns/{campaign_id}/status – aktivointi / pysäytys / arkistointi
    yhdellä napilla.

    Runko: {"status": "draft" | "active" | "paused" | "archived"}. Vain tila muuttuu,
    muut kentät pysyvät. Palauttaa päivitetyn kampanjan. Virheet: 404 ei löydy,
    422 tuntematon tila. (Huom. tämä ei tarkista päivämääriä kuten CampaignIn.)
    """
    if not update_row(conn, "campaigns", campaign_id, {"status": body.status}):
        raise HTTPException(404, "Kampanjaa ei löytynyt.")
    return _get_or_404(conn, campaign_id)


@router.delete("/{campaign_id}", status_code=204)
def delete_campaign(campaign_id: int, conn=Depends(get_conn)):
    """DELETE /api/campaigns/{campaign_id} – poistaa kampanjan. Palauttaa 204.

    Virheet: 404 ei löydy.
    """
    # Kampanjan mainospaikkaliitokset poistuvat myös (ON DELETE CASCADE).
    # Kampanjan mainokset jäävät talteen ilman kampanjaa (ON DELETE SET NULL).
    # Kampanjan tilastot poistuvat – paneelissa kannattaa ensisijaisesti arkistoida.
    if not delete_row(conn, "campaigns", campaign_id):
        raise HTTPException(404, "Kampanjaa ei löytynyt.")
