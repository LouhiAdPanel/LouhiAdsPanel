"""Mainosten jakelu ja seuranta (määrittely luvut 4, 10 ja 12).

Verkkosivut (mainostagi louhi-ads.js):
  GET  /api/v1/ad?placement=<code>   -> mainos JSONina tai 204 No Content
  POST /api/v1/view?t=<token>         -> kirjaa näytön, kun mainos on oikeasti näkynyt
  GET  /api/v1/click/{impression_id}  -> kirjaa klikin näytölle ja 302-ohjaus kohdesivulle
  GET  /api/v1/click?t=<token>        -> klikki ennen näytön kirjausta (luo näytön ja klikin)

Sähköposti / uutiskirje (ei JavaScriptiä, ks. newsletter/):
  GET  /api/v1/email/img?placement=<code>&r=<vastaanottaja>    -> kirjaa näytön, 302 kuvaan
  GET  /api/v1/email/click?placement=<code>&r=<vastaanottaja>  -> kirjaa klikin, 302 kohteeseen

Oikeudet: JULKINEN. Näitä kutsutaan muiden sivustojen sivuilta ja sähköpostiohjelmista
loppukäyttäjän laitteella, joten kirjautumista ei vaadita (ks. main.py).

Milloin näyttö kirjataan (tiimin päätös, IAB:n näkyvyysstandardi):
  Verkkosivu: /ad vain VALITSEE mainoksen eikä kirjaa mitään. Mainostagi kirjaa näytön
  (/view) vasta, kun kuva on latautunut ja vähintään 50 % mainoksesta on ollut näkyvissä
  yhtäjaksoisesti 1 sekunnin. Näin mainoksenestäjän piilottamat tai sivun alareunaan
  jääneet mainokset eivät kasvata näyttömäärää. /view palauttaa näytön id:n sisältävän
  klikkiosoitteen, jonka tagi vaihtaa linkkiin. Jos käyttäjä ehtii klikata ennen kuin
  näyttö on kirjattu, /click?t= kirjaa samalla näytön (klikattu mainos on nähty).
  Sähköposti: näyttö kirjataan, kun sähköpostiohjelma lataa mainoskuvan (alan tapa
  mitata uutiskirjeen mainosnäyttöjä).

Token (t): /ad antaa allekirjoitetun tunnisteen "sijoitus.aikaleima.allekirjoitus".
Allekirjoitus (HMAC-SHA256) estää keksimästä tunnisteita mielivaltaisille sijoituksille,
ja aikaleima rajaa käyttöajan (näyttö 1 h, klikki 24 h).

Kirjatut näytöt ja klikit näkyvät raporteissa (stats.py).
"""
import base64
import hashlib
import hmac
import os
import random
import struct
import time
import zlib
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from ..db import DATABASE_URL, get_conn

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
ORDER BY pl.id   -- vakaa järjestys: sähköpostin arvonta toistuu samana (ks. _pick)
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


# ---------- Allekirjoitettu tunniste (token) ----------
# Salainen avain: ympäristömuuttuja TRACKING_SECRET, tai sen puuttuessa tietokantaosoitteesta
# johdettu avain (pysyy samana palvelimen uudelleenkäynnistyksissä eikä näy selaimelle).
_SECRET = (os.getenv("TRACKING_SECRET") or "louhi-ads:" + DATABASE_URL).encode()
VIEW_MAX_AGE = 3600          # näyttö kirjattava tunnin sisällä mainoksen hausta
CLICK_MAX_AGE = 24 * 3600    # klikki hyväksytään vuorokauden ajan


def _sig(msg: str) -> str:
    digest = hmac.new(_SECRET, msg.encode(), hashlib.sha256).digest()[:16]
    return base64.urlsafe_b64encode(digest).decode().rstrip("=")


def make_token(placing_id: int) -> str:
    """Sijoituksen id + aikaleima + allekirjoitus, esim. '12.1730000000.Xy3...'."""
    msg = f"{placing_id}.{int(time.time())}"
    return f"{msg}.{_sig(msg)}"


def read_token(token: str, max_age: int) -> int | None:
    """Palauttaa sijoituksen id:n, jos tunniste on aito ja voimassa, muuten None."""
    try:
        placing_id, ts, sig = token.split(".")
        ok = hmac.compare_digest(sig, _sig(f"{placing_id}.{ts}"))
        if ok and 0 <= time.time() - int(ts) <= max_age:
            return int(placing_id)
    except ValueError:
        pass
    return None


def _record_impression(conn, placing_id: int) -> int | None:
    """Kirjaa näytön. None, jos sijoitusta ei enää ole (esim. poistettu välissä)."""
    row = conn.execute(
        """INSERT INTO impressions (placing_id)
           SELECT id FROM placings WHERE id = %s RETURNING id""", [placing_id]).fetchone()
    return row["id"] if row else None


@router.get("/ad")
def get_ad(
    request: Request,
    placement: str = Query(min_length=1, max_length=64, description="Placement ID"),
    conn=Depends(get_conn),
):
    """GET /api/v1/ad?placement=<code> – valitsee ja palauttaa mainoksen (julkinen).

    Valinta: ehdokkaat (ELIGIBLE_SQL) -> arvonta painoarvojen suhteessa (score), joten
    jokainen näytettävissä oleva mainos voi tulla valituksi.
    Näyttöä EI kirjata tässä: mainostagi kutsuu view_url-osoitetta, kun mainos on
    oikeasti näkynyt (50 % näkyvissä 1 s). Ennen sitä linkki osoittaa click_url-
    osoitteeseen, joka kirjaa klikatessa sekä näytön että klikin.
    Palauttaa JSONin {creative_id, campaign_id, image_url (absoluuttinen), view_url,
    click_url, alt_text, width, height, placement_width, placement_height}, tai 204
    No Content, jos paikalle ei ole näytettävää. Tagi jättää paikan silloin tyhjäksi.
    Virheet: 422, jos placement puuttuu tai on liian pitkä.
    """
    candidates = conn.execute(ELIGIBLE_SQL, [placement]).fetchall()
    if not candidates:
        return Response(status_code=204, headers=NO_CACHE)

    # Painotettu satunnaisvalinta painoarvojen suhteessa (luku 8).
    ad = random.choices(candidates, weights=[score(c) for c in candidates], k=1)[0]
    token = make_token(ad["placing_id"])
    return JSONResponse(
        {
            "creative_id": ad["creative_id"],
            "campaign_id": ad["campaign_id"],
            "image_url": _absolute(request, ad["image_url"]),
            "view_url": str(request.url_for("view")) + f"?t={token}",
            "click_url": str(request.url_for("click_token")) + f"?t={token}",
            "alt_text": ad["alt_text"],
            "width": ad["width"],
            "height": ad["height"],
            # Mainospaikan koko: mainostagi skaalaa kuvan tämän kokoiseen tilaan
            "placement_width": ad["placement_width"],
            "placement_height": ad["placement_height"],
        },
        headers=NO_CACHE,
    )


@router.post("/view", name="view")
def view(request: Request, t: str = Query(max_length=200), conn=Depends(get_conn)):
    """POST /api/v1/view?t=<token> – kirjaa näytön, kun mainos on näkynyt (julkinen).

    Mainostagi kutsuu tätä kerran mainosta kohden. Palauttaa {impression_id, click_url},
    jossa click_url kirjaa klikin juuri tälle näytölle.
    Virheet: 404, jos tunniste on virheellinen tai vanhentunut tai sijoitus on poistettu.
    """
    placing_id = read_token(t, VIEW_MAX_AGE)
    impression_id = _record_impression(conn, placing_id) if placing_id else None
    if not impression_id:
        raise HTTPException(404, "Tunniste on virheellinen tai vanhentunut.")
    return JSONResponse(
        {"impression_id": impression_id,
         "click_url": str(request.url_for("click", impression_id=impression_id))},
        headers=NO_CACHE,
    )


def _absolute(request: Request, url: str) -> str:
    """/media/x.png -> http://palvelin/media/x.png (mainos näytetään muiden sivustojen sivuilla)."""
    return str(request.base_url).rstrip("/") + url if url.startswith("/") else url


def _add_utm(url: str, campaign: str, medium: str = "internal_display") -> str:
    """Lisää UTM-parametrit, ellei kohdeosoitteessa ole niitä jo.

    UTM-parametrien avulla kohdesivuston analytiikka (esim. Google Analytics) tunnistaa,
    että kävijä tuli Louhi Adsin mainoksesta: utm_source=louhi,
    utm_medium=internal_display (uutiskirjeessä newsletter) ja utm_campaign=kampanjan tunnus.
    setdefault ei korvaa arvoja, jotka mainostaja on jo itse kirjoittanut osoitteeseen.
    Esim. https://x.fi/?a=1 -> https://x.fi/?a=1&utm_source=louhi&utm_medium=...
    """
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.setdefault("utm_source", "louhi")
    query.setdefault("utm_medium", medium)
    query.setdefault("utm_campaign", campaign)
    return urlunsplit(parts._replace(query=urlencode(query)))


# Näytöstä sijoitukseen ja mainokseen. UTM-kampanjatunnus: kampanjan utm_campaign,
# muuten 'campaign_<id>', ja ilman kampanjaa 'creative_<mainoksen id>'.
TARGET_SQL = """
SELECT cr.target_url,
       COALESCE(c.utm_campaign, 'campaign_' || c.id, 'creative_' || cr.id) AS utm_campaign
FROM placings pl
JOIN creatives cr     ON cr.id = pl.creative_id
LEFT JOIN campaigns c ON c.id = pl.campaign_id
"""


def _click_redirect(conn, impression_id: int, medium: str = "internal_display"):
    """Kirjaa klikin näytölle ja ohjaa mainoksen kohdesivulle (302)."""
    row = conn.execute(
        TARGET_SQL + " JOIN impressions i ON i.placing_id = pl.id WHERE i.id = %s",
        [impression_id]).fetchone()
    if not row:
        return Response("Mainosta ei löytynyt.", status_code=404)
    conn.execute("INSERT INTO clicks (impression_id) VALUES (%s)", [impression_id])
    return RedirectResponse(
        _add_utm(row["target_url"], row["utm_campaign"], medium), status_code=302, headers=NO_CACHE
    )


@router.get("/click/{impression_id}", name="click")
def click(impression_id: int, conn=Depends(get_conn)):
    """GET /api/v1/click/{impression_id} – klikin kirjaus ja ohjaus (julkinen).

    Kirjaa klikin clicks-tauluun (viittaa näyttöön, jota klikattiin) ja palauttaa
    302-uudelleenohjauksen mainoksen kohdesivulle (target_url + UTM-parametrit).
    Virheet: 404 tekstinä, jos näyttöä ei ole.
    """
    return _click_redirect(conn, impression_id)


@router.get("/click", name="click_token")
def click_token(t: str = Query(max_length=200), conn=Depends(get_conn)):
    """GET /api/v1/click?t=<token> – klikki ennen kuin näyttö ehdittiin kirjata (julkinen).

    Klikattu mainos on nähty, joten kirjataan ensin näyttö ja sitten klikki sille.
    Virheet: 404 tekstinä, jos tunniste on virheellinen tai vanhentunut.
    """
    placing_id = read_token(t, CLICK_MAX_AGE)
    impression_id = _record_impression(conn, placing_id) if placing_id else None
    if not impression_id:
        return Response("Mainosta ei löytynyt tai linkki on vanhentunut.", status_code=404)
    return _click_redirect(conn, impression_id)


# ---------- Sähköposti / uutiskirje ----------
# Sähköpostiohjelmat eivät aja JavaScriptiä, joten mainos upotetaan tavallisena
# kuvana linkin sisällä (Mainospaikat-sivun Upotuskoodi, kun ympäristön kanava on email):
#   <a href=".../api/v1/email/click?placement=X&r=ID"><img src=".../api/v1/email/img?placement=X&r=ID"></a>
# Kuva ja linkki ovat kaksi erillistä pyyntöä. Jotta ne osoittavat samaan mainokseen,
# arvonta tehdään vastaanottajan tunnisteesta (r) lasketulla siemenellä: sama paikka + sama
# r = sama mainos. r on lähetysohjelman vastaanottajakohtainen tunniste (esim. Mailchimpin
# *|UNIQID|*). Jos painoarvoja muutetaan lähetyksen jälkeen, klikki voi osua eri mainokseen.

def _blank_png(width: int) -> bytes:
    """Läpinäkyvä PNG, kooltaan leveys × 1 px. Palautetaan, kun paikalle ei ole mainosta:
    sähköpostiin ei jää rikkinäisen kuvan merkkiä, ja koska kuvan leveys on paikan leveys
    ja korkeus 1 px, se ei myöskään vie tilaa (img width="600" + height:auto -> 1 px)."""
    def chunk(kind: bytes, data: bytes) -> bytes:
        return (struct.pack(">I", len(data)) + kind + data
                + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF))
    ihdr = struct.pack(">IIBBBBB", width, 1, 8, 6, 0, 0, 0)       # RGBA, 8 bittiä
    raw = b"\x00" + b"\x00\x00\x00\x00" * width                     # yksi läpinäkyvä rivi
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
            + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))


def _pick(conn, placement: str, recipient: str | None) -> dict | None:
    """Sama arvonta kuin verkkosivulla, mutta toistettavasti vastaanottajan mukaan."""
    candidates = conn.execute(ELIGIBLE_SQL, [placement]).fetchall()
    if not candidates:
        return None
    rng = random.Random(f"{placement}:{recipient}") if recipient else random
    return rng.choices(candidates, weights=[score(c) for c in candidates], k=1)[0]


@router.get("/email/img")
def email_image(
    request: Request,
    placement: str = Query(min_length=1, max_length=64),
    r: str | None = Query(default=None, max_length=100, description="Vastaanottajan tunniste"),
    conn=Depends(get_conn),
):
    """GET /api/v1/email/img?placement=<code>&r=<vastaanottaja> – uutiskirjeen mainoskuva.

    Valitsee mainoksen, kirjaa näytön ja ohjaa (302) mainoskuvaan. Ilman mainosta
    palauttaa läpinäkyvän, 1 px korkean kuvan (_blank_png). Näyttö kirjataan aina, kun kuva ladataan (myös
    saman viestin uudelleen avaus kirjataan uutena näyttönä).
    """
    ad = _pick(conn, placement, r)
    if not ad:
        place = conn.execute("SELECT width FROM placements WHERE code = %s", [placement]).fetchone()
        width = min(place["width"], 2000) if place else 1
        return Response(_blank_png(width), media_type="image/png", headers=NO_CACHE)
    _record_impression(conn, ad["placing_id"])
    return RedirectResponse(_absolute(request, ad["image_url"]), status_code=302, headers=NO_CACHE)


@router.get("/email/click")
def email_click(
    placement: str = Query(min_length=1, max_length=64),
    r: str | None = Query(default=None, max_length=100),
    conn=Depends(get_conn),
):
    """GET /api/v1/email/click?placement=<code>&r=<vastaanottaja> – uutiskirjeen mainosklikki.

    Arpoo saman mainoksen kuin kuva (sama r), kirjaa klikin ja ohjaa kohdesivulle
    (utm_medium=newsletter). Klikki liitetään sijoituksen viimeisimpään näyttöön; jos
    näyttöä ei ole (esim. kuvat estetty sähköpostiohjelmassa), kirjataan ensin näyttö.
    Virheet: 404 tekstinä, jos paikalle ei ole enää mainosta.
    """
    ad = _pick(conn, placement, r)
    if not ad:
        return Response("Mainos ei ole enää saatavilla.", status_code=404)
    row = conn.execute(
        "SELECT max(id) AS id FROM impressions WHERE placing_id = %s AND occurred_at > now() - interval '30 days'",
        [ad["placing_id"]]).fetchone()
    impression_id = row["id"] or _record_impression(conn, ad["placing_id"])
    return _click_redirect(conn, impression_id, medium="newsletter")
