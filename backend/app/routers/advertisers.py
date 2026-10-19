"""Mainostajat (advertisers) – CRUD-rajapinta hallintapaneelin Mainostajat-sivulle.

Endpointit (kaikki polun /api/advertisers alla):
  GET    /api/advertisers          -> kaikki mainostajat + kampanja- ja mainosmäärät
  GET    /api/advertisers/{id}     -> yksi mainostaja
  POST   /api/advertisers          -> uusi mainostaja            (vain admin)
  PUT    /api/advertisers/{id}     -> mainostajan päivitys       (vain admin)
  DELETE /api/advertisers/{id}     -> mainostajan poisto         (vain admin)

Oikeudet: main.py liittää tämän routerin get_current_user-riippuvuudella, joten
kaikki kutsut vaativat kirjautumisen. Kirjoittavat operaatiot vaativat lisäksi
admin-roolin (dependencies=[Depends(require_admin)] reittikohtaisesti).

Liittyy: mainostajalla on kampanjoita (campaigns.advertiser_id), ja kampanjoilla
mainoksia (creatives). Lomakkeen kentät validoidaan schemas.AdvertiserIn-mallilla.
"""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_admin
from ..db import delete_row, get_conn, insert_row, update_row
from ..schemas import AdvertiserIn

# APIRouter kokoaa tämän tiedoston reitit; prefix lisätään jokaisen polun eteen ja
# tags ryhmittelee reitit /docs-sivun API-dokumentaatiossa.
router = APIRouter(prefix="/api/advertisers", tags=["Mainostajat"])

# Mainostajalista laskettuine lukuineen:
#   - campaign_count: mainostajan kaikki kampanjat
#   - active_campaign_count: kampanjat, joiden näyttötila (display_status) on 'active'.
#     v_campaign_status on näkymä (schema.sql), joka laskee tilan päivämäärien perusteella
#     (esim. 'active' + alkamispäivä tulevaisuudessa -> 'pending').
#   - creative_count: alikysely, joka laskee mainokset kaikista mainostajan kampanjoista.
# LEFT JOIN pitää mukana myös mainostajat, joilla ei ole kampanjoita (määrä 0).
# {where} korvataan Pythonissa .format():lla: tyhjä = kaikki, tai "WHERE a.id = %s" = yksi.
# Itse id-arvo välitetään erikseen parametrina (%s), ei liitetä merkkijonoon (SQL-injektio).
LIST_SQL = """
SELECT a.*,
       count(c.id)                                              AS campaign_count,
       count(c.id) FILTER (WHERE c.display_status = 'active')   AS active_campaign_count,
       (SELECT count(*) FROM creatives cr
          JOIN campaigns c2 ON c2.id = cr.campaign_id
         WHERE c2.advertiser_id = a.id)                         AS creative_count
FROM advertisers a
LEFT JOIN v_campaign_status c ON c.advertiser_id = a.id
{where}
GROUP BY a.id
ORDER BY a.name
"""


@router.get("")
def list_advertisers(conn=Depends(get_conn)):
    """GET /api/advertisers – listaa kaikki mainostajat nimen mukaan järjestettynä.

    Palauttaa listan mainostajista lukumäärineen (ks. LIST_SQL).
    conn=Depends(get_conn) tarkoittaa, että FastAPI antaa funktiolle tietokantayhteyden
    automaattisesti (db.get_conn); muutokset commitoidaan pyynnön lopussa tai
    perutaan (rollback), jos tapahtuu virhe. Sama käytäntö kaikissa routereissa.
    """
    return conn.execute(LIST_SQL.format(where="")).fetchall()


@router.get("/{advertiser_id}")
def get_advertiser(advertiser_id: int, conn=Depends(get_conn)):
    """GET /api/advertisers/{advertiser_id} – yksi mainostaja lukumäärineen.

    Virheet: 404, jos mainostajaa ei ole. (422, jos id ei ole kokonaisluku – FastAPI.)
    """
    row = conn.execute(LIST_SQL.format(where="WHERE a.id = %s"), [advertiser_id]).fetchone()
    if not row:
        raise HTTPException(404, "Mainostajaa ei löytynyt.")
    return row


@router.post("", status_code=201, dependencies=[Depends(require_admin)])
def create_advertiser(body: AdvertiserIn, conn=Depends(get_conn)):
    """POST /api/advertisers – luo mainostajan (vain admin).

    Runko validoidaan AdvertiserIn-mallilla (virheellinen -> 422).
    Palauttaa luodun rivin (201). Virheet: 403 ei-admin, 409 esim. nimi jo käytössä
    (tietokannan UNIQUE-rajoite, käännetään viestiksi main.py:n virheenkäsittelijässä).
    """
    return insert_row(conn, "advertisers", body.model_dump())


@router.put("/{advertiser_id}", dependencies=[Depends(require_admin)])
def update_advertiser(advertiser_id: int, body: AdvertiserIn, conn=Depends(get_conn)):
    """PUT /api/advertisers/{advertiser_id} – korvaa mainostajan tiedot (vain admin).

    Palauttaa päivitetyn rivin. Virheet: 403 ei-admin, 404 ei löydy, 409/422 kuten luonnissa.
    """
    row = update_row(conn, "advertisers", advertiser_id, body.model_dump())
    if not row:
        raise HTTPException(404, "Mainostajaa ei löytynyt.")
    return row


@router.delete("/{advertiser_id}", status_code=204, dependencies=[Depends(require_admin)])
def delete_advertiser(advertiser_id: int, conn=Depends(get_conn)):
    """DELETE /api/advertisers/{advertiser_id} – poistaa mainostajan (vain admin).

    Palauttaa 204 No Content (ei runkoa). Virheet: 403 ei-admin, 404 ei löydy,
    409 jos mainostajalla on vielä kampanjoita.
    """
    # Mainostajaa, jolla on kampanjoita, ei voi poistaa (ON DELETE RESTRICT -> 409).
    # Tietokanta estää poiston, ja main.py muuttaa IntegrityErrorin 409-vastaukseksi.
    if not delete_row(conn, "advertisers", advertiser_id):
        raise HTTPException(404, "Mainostajaa ei löytynyt.")
