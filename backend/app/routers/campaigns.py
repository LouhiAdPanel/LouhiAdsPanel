"""Kampanjat – rajapinta hallintapaneelin Kampanjat-sivulle (campaigns.html).

Endpointit (polun /api/campaigns alla):
  GET    /api/campaigns               -> kampanjalista, suodatus tilalla/mainostajalla/nimellä
  GET    /api/campaigns/{id}          -> yksi kampanja
  POST   /api/campaigns               -> uusi kampanja
  PUT    /api/campaigns/{id}          -> kampanjan päivitys
  PATCH  /api/campaigns/{id}/status   -> pelkän tilan vaihto (aktivointi/pysäytys/arkistointi)
  DELETE /api/campaigns/{id}          -> kampanjan poisto

Oikeudet: kaikki kirjautuneet (admin ja editor); main.py lisää kirjautumisvaatimuksen.

Liittyy: kampanja kuuluu mainostajalle (advertisers). Kampanja on valinnainen tapa
ryhmitellä mainostajan sijoituksia (placings): sijoitus = mainos tietyssä mainospaikassa,
ja sen kampanja valitaan mainoslomakkeella (routers/creatives.py). Kampanjalle valitaan
sallitut mainospaikat (campaign_placements); kampanjan sijoitukset voivat olla vain niissä.
Jakelu (serving.py) näyttää kampanjan sijoituksia vain, kun kampanja on aktiivinen ja
käynnissä ja paikka on kampanjan sallittu paikka.
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
#   - placements: kampanjan sallitut mainospaikat JSON-listana [{id, name, code}, ...]
#     nimen mukaan (campaign_placements). Ei paikkoja -> '[]'.
#   - creative_count: kampanjan eri mainosten määrä voimassa olevista sijoituksista
#     (tilassa 'inactive' olevat eli mainoslomakkeelta poistetut eivät ole mukana).
# WHERE-ehdot ovat valinnaisia suodattimia: "(%(x)s IS NULL OR ...)" = jos parametri on
# None, ehto ei rajaa mitään. Näin samalla kyselyllä haetaan lista ja yksittäinen rivi.
# ::int / ::text kertovat PostgreSQL:lle parametrin tyypin, kun arvo on NULL.
# ILIKE = kirjainkoosta riippumaton haku; '%%' on psycopgissa escapattu %-jokerimerkki.
LIST_SQL = """
SELECT c.*,
       a.name AS advertiser_name,
       COALESCE((SELECT json_agg(json_build_object('id', p.id, 'name', p.name, 'code', p.code)
                                 ORDER BY p.name)
                 FROM campaign_placements cp JOIN placements p ON p.id = cp.placement_id
                 WHERE cp.campaign_id = c.id), '[]') AS placements,
       (SELECT count(DISTINCT pl.creative_id) FROM placings pl
         WHERE pl.campaign_id = c.id AND pl.status <> 'inactive') AS creative_count,
       -- kampanjan mainokset (lomakkeen Mainokset-monivalintaa varten)
       COALESCE((SELECT json_agg(DISTINCT pl.creative_id) FROM placings pl
                 WHERE pl.campaign_id = c.id AND pl.status <> 'inactive'), '[]') AS creative_ids
FROM v_campaign_status c
JOIN advertisers a ON a.id = c.advertiser_id
WHERE (%(id)s::int            IS NULL OR c.id = %(id)s)
  AND (%(status)s::text       IS NULL OR c.display_status = %(status)s)
  AND (%(advertiser_id)s::int IS NULL OR c.advertiser_id = %(advertiser_id)s)
  AND (%(q)s::text            IS NULL OR c.name ILIKE '%%' || %(q)s || '%%')
ORDER BY c.start_time DESC NULLS LAST, c.name
"""

DisplayStatus = Literal["draft", "active", "paused", "archived", "pending", "ended"]


def _fetch(conn, **filters):
    """Ajaa LIST_SQL:n. Antamattomat suodattimet ovat None (= ei rajausta)."""
    params = {"id": None, "status": None, "advertiser_id": None, "q": None, **filters}
    return conn.execute(LIST_SQL, params).fetchall()


def _set_placements(conn, campaign_id: int, placement_ids: list[int]):
    """Asettaa kampanjan sallitut mainospaikat: vanhat liitokset poistetaan ja uudet lisätään.

    Sama transaktio kuin kampanjan tallennus, joten virheessä kumpikaan ei jää voimaan.
    Olematon placement_id -> ForeignKeyViolation -> 409 (main.py). Jos paikka poistetaan
    kampanjalta, kampanjan sijoitukset siinä paikassa lakkaavat näkymästä (serving.py).
    """
    conn.execute("DELETE FROM campaign_placements WHERE campaign_id = %s", [campaign_id])
    if placement_ids:
        # unnest purkaa id-taulukon riveiksi; set() poistaa tuplat.
        conn.execute(
            """INSERT INTO campaign_placements (campaign_id, placement_id)
               SELECT %s, unnest(%s::int[]) ON CONFLICT DO NOTHING""",
            [campaign_id, list(set(placement_ids))],
        )


def _set_creatives(conn, campaign_id: int, advertiser_id: int, creative_ids: list[int] | None):
    """Liittää kampanjaan lomakkeella valitut mainokset ja irrottaa poistetut.

    Mainos on kampanjassa sijoitustensa (placings.campaign_id) kautta.
    - Uusi valittu mainos: sille tehdään sijoitus jokaiseen kampanjan mainospaikkaan
      (tai olemassa oleva sijoitus liitetään kampanjaan ja aktivoidaan). Mainoksen
      sijoitukset muissa paikoissa merkitään ei-aktiivisiksi, koska kampanjan mainos saa
      näkyä vain kampanjan paikoissa. Painoarvo säilyy (uusille sijoituksille mainoksen
      nykyinen painoarvo tai oletus 50).
    - Valinnoista poistettu mainos: sen kampanjasijoitukset irrotetaan kampanjasta ja
      merkitään ei-aktiivisiksi (kuten kampanjan poistossa), jottei mainos ala yllättäen
      näkyä kampanjan aikataulun ulkopuolella. Mainoksen voi aktivoida mainoslomakkeella.
    - Jo kampanjassa olevaan mainokseen ei kosketa.
    creative_ids = None -> ei muutoksia. Virheet: 422 vieraan mainostajan mainos tai
    kampanjalla ei mainospaikkoja.
    """
    if creative_ids is None:
        return
    wanted = set(creative_ids)
    current = {r["creative_id"] for r in conn.execute(
        "SELECT DISTINCT creative_id FROM placings WHERE campaign_id = %s AND status <> 'inactive'",
        [campaign_id])}
    if wanted:
        own = {r["id"] for r in conn.execute(
            "SELECT id FROM creatives WHERE id = ANY(%s) AND advertiser_id = %s",
            [list(wanted), advertiser_id])}
        if own != wanted:
            raise HTTPException(422, "Kampanjaan voi liittää vain saman mainostajan mainoksia.")
    removed, added = current - wanted, wanted - current
    if removed:
        conn.execute(
            """UPDATE placings SET campaign_id = NULL, status = 'inactive'
               WHERE campaign_id = %s AND creative_id = ANY(%s)""", [campaign_id, list(removed)])
    if not added:
        return
    places = [r["placement_id"] for r in conn.execute(
        "SELECT placement_id FROM campaign_placements WHERE campaign_id = %s", [campaign_id])]
    if not places:
        raise HTTPException(422, "Valitse kampanjalle mainospaikat, jotta siihen voi liittää mainoksia.")
    for creative_id in added:
        conn.execute(
            """UPDATE placings SET status = 'inactive'
               WHERE creative_id = %s AND NOT (placement_id = ANY(%s))""", [creative_id, places])
        conn.execute(
            """INSERT INTO placings (advertiser_id, creative_id, campaign_id, placement_id,
                                     weight, priority, status)
               SELECT %(adv)s, %(cr)s, %(camp)s, unnest(%(places)s::int[]), 1,
                      COALESCE((SELECT max(priority) FROM placings WHERE creative_id = %(cr)s), 50),
                      'active'
               ON CONFLICT (creative_id, placement_id) DO UPDATE
                  SET campaign_id = EXCLUDED.campaign_id, status = 'active'""",
            {"adv": advertiser_id, "cr": creative_id, "camp": campaign_id, "places": places})


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
    """POST /api/campaigns – luo kampanjan ja sen sallitut mainospaikat.

    placement_ids ja creative_ids eivät ole campaigns-taulun sarakkeita: paikat tallennetaan
    liitostauluun ja mainokset liitetään sijoitusten kautta (_set_creatives). Mainoksen voi
    liittää kampanjaan myös mainoslomakkeella.
    Palauttaa kampanjan listamuodossa (201).
    Virheet: 422 virheellinen runko (esim. aktiivinen ilman päivämääriä, CampaignIn),
    409 olematon mainostaja tai mainospaikka.
    """
    row = insert_row(conn, "campaigns", body.model_dump(exclude={"placement_ids", "creative_ids"}))
    _set_placements(conn, row["id"], body.placement_ids)
    _set_creatives(conn, row["id"], body.advertiser_id, body.creative_ids)
    return _get_or_404(conn, row["id"])


@router.put("/{campaign_id}")
def update_campaign(campaign_id: int, body: CampaignIn, conn=Depends(get_conn)):
    """PUT /api/campaigns/{campaign_id} – korvaa kampanjan tiedot ja sallitut mainospaikat.

    Mainostajaa ei voi vaihtaa, jos kampanjalla on sijoituksia: sijoitusten mainokset
    kuuluvat alkuperäiselle mainostajalle (tietokannan yhdistelmäviiteavain).
    Palauttaa päivitetyn kampanjan. Virheet: 404 ei löydy, 409 mainostajan vaihto
    estetty, muuten kuten luonnissa.
    """
    old = conn.execute("SELECT advertiser_id FROM campaigns WHERE id = %s", [campaign_id]).fetchone()
    if not old:
        raise HTTPException(404, "Kampanjaa ei löytynyt.")
    if old["advertiser_id"] != body.advertiser_id and conn.execute(
            "SELECT 1 FROM placings WHERE campaign_id = %s LIMIT 1", [campaign_id]).fetchone():
        raise HTTPException(409, "Kampanjalla on mainoksia, joten mainostajaa ei voi vaihtaa. "
                                 "Irrota mainokset kampanjasta ensin Mainokset-sivulla.")
    update_row(conn, "campaigns", campaign_id, body.model_dump(exclude={"placement_ids", "creative_ids"}))
    _set_placements(conn, campaign_id, body.placement_ids)
    _set_creatives(conn, campaign_id, body.advertiser_id, body.creative_ids)
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
    # Kampanjan sijoitukset irrotetaan kampanjasta ja merkitään ei-aktiivisiksi ennen
    # poistoa. Muuten ne jäisivät jakeluun ilman kampanjan aikataulua. Mainokset ja
    # tilastot säilyvät (sijoituksia ei poisteta); sijoitukset voi ottaa uudelleen
    # käyttöön mainoslomakkeella. Paneelissa kannattaa silti mieluummin arkistoida.
    conn.execute("UPDATE placings SET campaign_id = NULL, status = 'inactive' WHERE campaign_id = %s",
                 [campaign_id])
    if not delete_row(conn, "campaigns", campaign_id):
        raise HTTPException(404, "Kampanjaa ei löytynyt.")
