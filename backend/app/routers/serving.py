"""Mainosten jakelu (määrittely luvut 4, 10 ja 12).

GET /api/v1/ad?placement=<code>      -> mainos JSONina tai 204 No Content
GET /api/v1/click/{creative_id}       -> rekisteröi klikin ja 302-ohjaus kohdesivulle

Oikeudet: JULKINEN. Näitä kutsuu mainostagi (louhi-ads.js) muiden sivustojen sivuilla
loppukäyttäjän selaimessa, joten kirjautumista ei vaadita (ks. main.py).

Kulku: 1) tagi kysyy /ad?placement=<code> -> palvelin valitsee mainoksen, kirjaa näytön
(impressions) ja palauttaa kuvan osoitteen ja klikkiosoitteen. 2) Kun käyttäjä klikkaa,
selain avaa /click/<id> -> palvelin kirjaa klikin (clicks) ja ohjaa mainoksen kohdesivulle
UTM-parametrein. Kirjatut näytöt ja klikit näkyvät raporteissa (stats.py).
"""
import random
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from ..db import get_conn

router = APIRouter(prefix="/api/v1", tags=["Mainosten jakelu"])

# Vastauksia ei saa tallentaa välimuistiin: jokainen sivulataus arpoo mainoksen uudelleen
# ja jokainen näyttö/klikki halutaan kirjata.
NO_CACHE = {"Cache-Control": "no-store"}

# Luku 10, kohdat 1–5: aktiivinen mainospaikka -> aktiiviset, käynnissä olevat
# kampanjat -> niiden aktiiviset mainokset, joiden paino > 0.
#
# Hakee kaikki ehdokasmainokset, jotka saa näyttää annetussa mainospaikassa (code = %s):
#   - JOIN-ketju: mainospaikka -> siihen liitetyt kampanjat (campaign_placements)
#     -> kampanjoiden mainokset. Kampanjattomat mainokset eivät siis tule mukaan.
#   - Aktiivisuus: paikan, kampanjan ja mainoksen status on 'active'.
#   - Päivämäärät: kampanja on alkanut (start_time <= nyt) eikä ole päättynyt
#     (end_time > nyt). Luonnos/pysäytetty/arkistoitu kampanja ei näy.
#   - weight > 0: painolla 0 mainoksen voi "piilottaa" poistamatta sitä.
#   - Kokosuodatus: mainos saa olla enintään paikan kokoinen; jos mainoksen mittoja
#     ei tiedetä (NULL, esim. ulkoinen kuva), se hyväksytään.
# Prioriteetti ja painotettu arvonta tehdään Pythonissa (get_ad), ei SQL:ssä.
ELIGIBLE_SQL = """
SELECT cr.id AS creative_id, cr.campaign_id, cr.image_url, cr.target_url,
       cr.alt_text, cr.width, cr.height, cr.weight,
       c.priority, p.id AS placement_id
FROM placements p
JOIN campaign_placements cp ON cp.placement_id = p.id
JOIN campaigns c            ON c.id = cp.campaign_id
JOIN creatives cr           ON cr.campaign_id = c.id
WHERE p.code = %s
  AND p.status  = 'active'
  AND c.status  = 'active'
  AND c.start_time <= now()
  AND c.end_time   >  now()
  AND cr.status = 'active'
  AND cr.weight > 0
  -- Mainospaikan koko on maksimikoko: liian suurta mainosta ei näytetä
  AND (cr.width  IS NULL OR cr.width  <= p.width)
  AND (cr.height IS NULL OR cr.height <= p.height)
"""
# Kohdennussäännöt (targeting_rules) lisätään tähän myöhemmin (luku 9).


@router.get("/ad")
def get_ad(
    request: Request,
    placement: str = Query(min_length=1, max_length=64, description="Placement ID"),
    conn=Depends(get_conn),
):
    """GET /api/v1/ad?placement=<code> – valitsee ja palauttaa mainoksen (julkinen).

    Valinta: ehdokkaat (ELIGIBLE_SQL) -> korkein prioriteetti -> painotettu arvonta.
    Valittu näyttö kirjataan impressions-tauluun.
    Palauttaa JSONin {creative_id, campaign_id, image_url (absoluuttinen), click_url,
    alt_text, width, height}, tai 204 No Content, jos paikalle ei ole näytettävää
    (tuntematon/passiivinen paikka tai ei käynnissä olevia kampanjoita). Tagi jättää
    paikan silloin tyhjäksi. Virheet: 422, jos placement puuttuu tai on liian pitkä.
    """
    candidates = conn.execute(ELIGIBLE_SQL, [placement]).fetchall()
    if not candidates:
        return Response(status_code=204, headers=NO_CACHE)

    # Korkeimman prioriteetin kampanjat ensin (oletuksena kaikilla 0 = ei vaikutusta),
    # sitten painotettu satunnaisvalinta (luku 8).
    # Esim. painot 3 ja 1 -> ensimmäinen näytetään keskimäärin 75 %:ssa kerroista.
    # Alemman prioriteetin kampanjat näkyvät vain, jos korkeampia ei ole lainkaan.
    top = max(c["priority"] for c in candidates)
    candidates = [c for c in candidates if c["priority"] == top]
    ad = random.choices(candidates, weights=[c["weight"] for c in candidates], k=1)[0]

    conn.execute(
        "INSERT INTO impressions (campaign_id, creative_id, placement_id) VALUES (%s, %s, %s)",
        [ad["campaign_id"], ad["creative_id"], ad["placement_id"]],
    )

    # Klikkiosoite osoittaa tämän palvelimen click-reittiin (name="click" alla), ei suoraan
    # kohdesivulle, jotta klikki saadaan kirjattua. Mainospaikan id välitetään mukana,
    # koska sama mainos voi näkyä useassa paikassa.
    click_url = str(request.url_for("click", creative_id=ad["creative_id"]))
    click_url += f"?placement={ad['placement_id']}"
    return JSONResponse(
        {
            "creative_id": ad["creative_id"],
            "campaign_id": ad["campaign_id"],
            "image_url": _absolute(request, ad["image_url"]),
            "click_url": click_url,
            "alt_text": ad["alt_text"],
            "width": ad["width"],
            "height": ad["height"],
        },
        headers=NO_CACHE,
    )


def _absolute(request: Request, url: str) -> str:
    """/media/x.png -> http://palvelin/media/x.png (mainos näytetään muiden sivustojen sivuilla)."""
    return str(request.base_url).rstrip("/") + url if url.startswith("/") else url


def _add_utm(url: str, campaign: str) -> str:
    """Lisää UTM-parametrit, ellei kohdeosoitteessa ole niitä jo.

    UTM-parametrien avulla kohdesivuston analytiikka (esim. Google Analytics) tunnistaa,
    että kävijä tuli Louhi Adsin mainoksesta: utm_source=louhi,
    utm_medium=internal_display ja utm_campaign=kampanjan tunnus.
    setdefault ei korvaa arvoja, jotka mainostaja on jo itse kirjoittanut osoitteeseen.
    Esim. https://x.fi/?a=1 -> https://x.fi/?a=1&utm_source=louhi&utm_medium=...
    """
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.setdefault("utm_source", "louhi")
    query.setdefault("utm_medium", "internal_display")
    query.setdefault("utm_campaign", campaign)
    return urlunsplit(parts._replace(query=urlencode(query)))


@router.get("/click/{creative_id}", name="click")
def click(creative_id: int, placement: int | None = None, conn=Depends(get_conn)):
    """GET /api/v1/click/{creative_id}?placement=<id> – klikin kirjaus ja ohjaus (julkinen).

    Kirjaa klikin clicks-tauluun ja palauttaa 302-uudelleenohjauksen mainoksen
    kohdesivulle (target_url + UTM-parametrit). Huom: placement on tässä mainospaikan
    numeerinen id (ei code), sillä se tulee /ad-vastauksen click_url-osoitteesta.
    Virheet: 404 tekstinä, jos mainosta ei ole tai sillä ei ole kampanjaa.
    """
    # Haetaan mainoksen kohdeosoite ja kampanjan UTM-tunnus. Jos kampanjalle ei ole
    # annettu utm_campaign-arvoa, käytetään muotoa 'campaign_<id>'.
    # Inner JOIN: kampanjaton mainos ei löydy (sitä ei myöskään jaeta).
    row = conn.execute(
        """SELECT cr.target_url, cr.campaign_id,
                  COALESCE(c.utm_campaign, 'campaign_' || c.id) AS utm_campaign
           FROM creatives cr JOIN campaigns c ON c.id = cr.campaign_id
           WHERE cr.id = %s""",
        [creative_id],
    ).fetchone()
    if not row:
        return Response("Mainosta ei löytynyt.", status_code=404)

    # Klikki tallennetaan vain, jos mainospaikka on olemassa – ohjaus tehdään aina.
    # INSERT ... SELECT ... WHERE p.id = %s lisää rivin vain, jos paikka löytyy; muuten
    # lisätään 0 riviä eikä tule virhettä (vrt. VALUES, joka kaatuisi viiteavaimeen).
    if placement is not None:
        conn.execute(
            """INSERT INTO clicks (campaign_id, creative_id, placement_id)
               SELECT %s, %s, p.id FROM placements p WHERE p.id = %s""",
            [row["campaign_id"], creative_id, placement],
        )

    return RedirectResponse(
        _add_utm(row["target_url"], row["utm_campaign"]), status_code=302, headers=NO_CACHE
    )
