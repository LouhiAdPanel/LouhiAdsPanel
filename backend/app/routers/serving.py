"""Mainosten jakelu (määrittely luvut 4, 10 ja 12).

GET /api/v1/ad?placement=<code>       -> mainos JSONina tai 204 No Content
GET /api/v1/click/{impression_id}     -> rekisteröi klikin ja 302-ohjaus kohdesivulle

Oikeudet: JULKINEN. Näitä kutsuu mainostagi (louhi-ads.js) muiden sivustojen sivuilla
loppukäyttäjän selaimessa, joten kirjautumista ei vaadita (ks. main.py).

Kulku: 1) tagi kysyy /ad?placement=<code> -> palvelin valitsee sijoituksen (placings),
kirjaa näytön (impressions) ja palauttaa kuvan osoitteen ja klikkiosoitteen, jossa on
näytön id. 2) Kun käyttäjä klikkaa, selain avaa /click/<näytön id> -> palvelin kirjaa
klikin (clicks) juuri tälle näytölle ja ohjaa mainoksen kohdesivulle UTM-parametrein.
Kirjatut näytöt ja klikit näkyvät raporteissa (stats.py).
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

# Luku 10: hakee kaikki sijoitukset, jotka saa näyttää mainospaikassa (code = %s):
#   - Sijoitus (placings) = mainos tässä paikassa. Kampanja on valinnainen.
#   - Aktiivisuus: paikan, sijoituksen, mainoksen ja mainostajan status on 'active'.
#   - Sijoituksen aikataulu: alkanut (start_time <= nyt) eikä päättynyt
#     (end_time NULL = toistaiseksi, tai end_time > nyt).
#   - Jos sijoituksella on kampanja, myös kampanjan on oltava aktiivinen ja käynnissä,
#     ja paikan on oltava kampanjan sallittu paikka (campaign_placements).
#     Ilman kampanjaa sijoitus näkyy pelkän oman aikataulunsa mukaan.
#   - priority (painoarvo) > 0: painoarvolla 0 sijoituksen voi "piilottaa" poistamatta sitä.
#   - Kokoa ei rajata: mainostagi skaalaa kuvan paikan kokoon (placement_width/height).
# Arvonta pisteiden perusteella tehdään Pythonissa (get_ad / score), ei SQL:ssä.
# Nimet (creative_name, campaign_name) tarvitaan Mainospaikat-sivun Näkyvyys-näkymään.
ELIGIBLE_SQL = """
SELECT pl.id AS placing_id, pl.campaign_id, cr.name AS creative_name, c.name AS campaign_name,
       pl.priority,   -- painoarvo 0–100 (lomakkeen Painoarvo, kaavion PLACING.priority)
       cr.id AS creative_id, cr.image_url, cr.target_url, cr.alt_text, cr.width, cr.height,
       p.width AS placement_width, p.height AS placement_height
FROM placements p
JOIN placings pl      ON pl.placement_id = p.id
JOIN creatives cr     ON cr.id = pl.creative_id
JOIN advertisers a    ON a.id = pl.advertiser_id
LEFT JOIN campaigns c ON c.id = pl.campaign_id
WHERE p.code = %s
  AND p.status  = 'active'
  AND pl.status = 'active'
  AND cr.status = 'active'
  AND a.status  = 'active'
  AND pl.priority > 0   -- painoarvo 0 = ei näytetä
  AND pl.start_time <= now()
  AND (pl.end_time IS NULL OR pl.end_time > now())
  AND (pl.campaign_id IS NULL
       OR (c.status = 'active' AND c.start_time <= now() AND c.end_time > now()
           AND EXISTS (SELECT 1 FROM campaign_placements cp
                       WHERE cp.campaign_id = pl.campaign_id AND cp.placement_id = p.id)))
"""
# Kohdennussäännöt (targeting_rules, sijoituskohtaiset) lisätään tähän myöhemmin (luku 9).

# ---------- Näkymistodennäköisyys ----------
# Jokainen näytettävissä oleva mainos on mukana arvonnassa. Mainoksen painoarvo on
# sijoituksen priority-sarake (tietokantakaavion PLACING.priority), jonka käyttäjä antaa
# mainoslomakkeen Painoarvo-kentässä (0–100, oletus 50). Todennäköisyys näkyä:
#     mainoksen painoarvo / paikan kaikkien mainosten painoarvojen summa
# Sama sääntö koskee kampanjan mainoksia ja irtomainoksia. Esim. painoarvot 50 ja 10:
# ensimmäinen näkyy 50/60 ≈ 83 %:ssa ja toinen 10/60 ≈ 17 %:ssa latauksista.
# (Sarake weight on jäänne aiemmasta mallista: sitä ei enää käytetä, arvo on aina 1.)


def score(candidate: dict) -> float:
    """Mainoksen osuus arvonnassa = sen painoarvo (placings.priority)."""
    return candidate["priority"]


def with_shares(candidates: list[dict]) -> list[dict]:
    """Lisää ehdokkaisiin todennäköisyyden prosentteina (Näkyvyys-näkymä,
    routers/placements.py). Järjestys: suurin osuus ensin."""
    total = sum(score(c) for c in candidates)
    rows = [{**c, "share": round(100 * score(c) / total, 1) if total else 0.0} for c in candidates]
    return sorted(rows, key=lambda r: -score(r))


@router.get("/ad")
def get_ad(
    request: Request,
    placement: str = Query(min_length=1, max_length=64, description="Placement ID"),
    conn=Depends(get_conn),
):
    """GET /api/v1/ad?placement=<code> – valitsee ja palauttaa mainoksen (julkinen).

    Valinta: ehdokkaat (ELIGIBLE_SQL) -> arvonta painoarvojen suhteessa (score), joten
    jokainen näytettävissä oleva mainos voi tulla valituksi.
    Valittu näyttö kirjataan impressions-tauluun.
    Palauttaa JSONin {creative_id, campaign_id, image_url (absoluuttinen), click_url,
    alt_text, width, height, placement_width, placement_height}, tai 204 No Content, jos
    paikalle ei ole näytettävää. Tagi jättää paikan silloin tyhjäksi.
    Virheet: 422, jos placement puuttuu tai on liian pitkä.
    """
    candidates = conn.execute(ELIGIBLE_SQL, [placement]).fetchall()
    if not candidates:
        return Response(status_code=204, headers=NO_CACHE)

    # Painotettu satunnaisvalinta painoarvojen suhteessa (luku 8).
    ad = random.choices(candidates, weights=[score(c) for c in candidates], k=1)[0]

    # RETURNING id: näytön id tarvitaan klikkiosoitteeseen (klikki kuuluu tähän näyttöön)
    impression = conn.execute(
        "INSERT INTO impressions (placing_id) VALUES (%s) RETURNING id", [ad["placing_id"]]
    ).fetchone()

    # Klikkiosoite osoittaa tämän palvelimen click-reittiin (name="click" alla), ei suoraan
    # kohdesivulle, jotta klikki saadaan kirjattua.
    click_url = str(request.url_for("click", impression_id=impression["id"]))
    return JSONResponse(
        {
            "creative_id": ad["creative_id"],
            "campaign_id": ad["campaign_id"],
            "image_url": _absolute(request, ad["image_url"]),
            "click_url": click_url,
            "alt_text": ad["alt_text"],
            "width": ad["width"],
            "height": ad["height"],
            # Mainospaikan koko: mainostagi skaalaa kuvan tämän kokoiseen tilaan
            "placement_width": ad["placement_width"],
            "placement_height": ad["placement_height"],
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


@router.get("/click/{impression_id}", name="click")
def click(impression_id: int, conn=Depends(get_conn)):
    """GET /api/v1/click/{impression_id} – klikin kirjaus ja ohjaus (julkinen).

    Kirjaa klikin clicks-tauluun (viittaa näyttöön, jota klikattiin) ja palauttaa
    302-uudelleenohjauksen mainoksen kohdesivulle (target_url + UTM-parametrit).
    Virheet: 404 tekstinä, jos näyttöä ei ole.
    """
    # Näytöstä sijoitukseen ja mainokseen. UTM-kampanjatunnus: kampanjan utm_campaign,
    # muuten 'campaign_<id>', ja ilman kampanjaa 'creative_<mainoksen id>'.
    row = conn.execute(
        """SELECT cr.target_url,
                  COALESCE(c.utm_campaign, 'campaign_' || c.id, 'creative_' || cr.id) AS utm_campaign
           FROM impressions i
           JOIN placings pl      ON pl.id = i.placing_id
           JOIN creatives cr     ON cr.id = pl.creative_id
           LEFT JOIN campaigns c ON c.id = pl.campaign_id
           WHERE i.id = %s""",
        [impression_id],
    ).fetchone()
    if not row:
        return Response("Mainosta ei löytynyt.", status_code=404)

    conn.execute("INSERT INTO clicks (impression_id) VALUES (%s)", [impression_id])
    return RedirectResponse(
        _add_utm(row["target_url"], row["utm_campaign"]), status_code=302, headers=NO_CACHE
    )
