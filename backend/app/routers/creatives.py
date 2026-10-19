"""Mainokset (creatives), niiden sijoitukset ja mainoskuvien lataus – Mainokset-sivu.

Endpointit (polun /api/creatives alla):
  POST   /api/creatives/upload   -> kuvatiedoston lataus, palauttaa image_url-osoitteen
  GET    /api/creatives          -> mainoslista (suodatus kampanjalla/mainostajalla/ilman kampanjaa)
  GET    /api/creatives/{id}     -> yksi mainos
  POST   /api/creatives          -> uusi mainos ja sen sijoitukset
  PUT    /api/creatives/{id}     -> mainoksen ja sen sijoitusten päivitys
  DELETE /api/creatives/{id}     -> mainoksen poisto (myös ladattu kuva poistetaan)

Oikeudet: kaikki kirjautuneet (main.py lisää kirjautumisvaatimuksen).

Tietomalli: mainos kuuluu mainostajalle (advertiser_id). Mainos näytetään sijoitusten
(taulu placings) kautta: yksi sijoitus = mainos yhdessä mainospaikassa omalla painolla,
prioriteetilla, aikataululla, tilalla ja valinnaisella kampanjalla. Lomakkeella valitaan
mainospaikat (vähintään yksi) ja yhteiset asetukset, ja jokaisesta paikasta tehdään
sijoitus. Kampanja EI ole pakollinen: ilman kampanjaa sijoitus näkyy oman aikataulunsa
mukaan.

Mainoksen tallennus on kaksivaiheinen: 1) frontend lataa kuvan /upload-reittiin, joka
tallentaa sen tietokantaan (media.py) ja palauttaa osoitteen /media/<nimi>; 2) lomake
tallennetaan POST/PUT-kutsulla, jossa image_url on tuo osoite. Kuvana voi olla myös
ulkoinen URL. Kuvan koko voi poiketa mainospaikan koosta: mainostagi skaalaa kuvan
mittasuhteet säilyttäen paikan kokoon (louhi-ads.js).
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from ..db import delete_row, get_conn, get_row, insert_row, pool, update_row
from ..media import MAX_UPLOAD_BYTES, InvalidImage, delete_local_image, local_image_size, save_image
from ..schemas import CreativeIn

router = APIRouter(prefix="/api/creatives", tags=["Mainokset"])

# Mainoslista mainostajan nimellä ja sijoitusten yhteenvedolla.
# LATERAL-alikysely kokoaa mainoksen voimassa olevat sijoitukset (status <> 'inactive'):
#   - placements: mainospaikat JSON-listana (+ sijoituksen id)
#   - campaign_id, weight, priority, start_time, end_time: lomake asettaa nämä kaikille
#     mainoksen sijoituksille samoiksi, joten yksi arvo (max/min) kuvaa niitä.
#     end_time on NULL (= toistaiseksi), jos yksikin sijoitus on ilman loppua.
# Ilman sijoituksia koostefunktiot palauttavat NULLin ja placements on '[]'.
# Suodattimet (None = ei rajausta): id, campaign_id (mainoksella sijoitus kampanjassa),
# advertiser_id, unassigned=True (ei kampanjaa).
LIST_SQL = """
SELECT cr.*,
       a.name AS advertiser_name,
       s.campaign_id, c.name AS campaign_name,
       s.weight, s.priority, s.start_time, s.end_time,
       COALESCE(s.placements, '[]') AS placements
FROM creatives cr
JOIN advertisers a ON a.id = cr.advertiser_id
LEFT JOIN LATERAL (
    SELECT max(pl.campaign_id) AS campaign_id, max(pl.weight) AS weight,
           max(pl.priority) AS priority, min(pl.start_time) AS start_time,
           CASE WHEN bool_or(pl.end_time IS NULL) THEN NULL ELSE max(pl.end_time) END AS end_time,
           json_agg(json_build_object('id', p.id, 'placing_id', pl.id, 'name', p.name,
                                      'code', p.code, 'width', p.width, 'height', p.height,
                                      'status', p.status) ORDER BY p.name) AS placements
    FROM placings pl JOIN placements p ON p.id = pl.placement_id
    WHERE pl.creative_id = cr.id AND pl.status <> 'inactive'
) s ON TRUE
LEFT JOIN campaigns c ON c.id = s.campaign_id
WHERE (%(id)s::int            IS NULL OR cr.id = %(id)s)
  AND (%(advertiser_id)s::int IS NULL OR cr.advertiser_id = %(advertiser_id)s)
  AND (%(campaign_id)s::int   IS NULL OR EXISTS (
        SELECT 1 FROM placings x WHERE x.creative_id = cr.id
           AND x.campaign_id = %(campaign_id)s AND x.status <> 'inactive'))
  AND (NOT %(unassigned)s OR s.campaign_id IS NULL)
ORDER BY a.name, cr.name
"""

# Valitut mainospaikat koon tarkistusta varten. ANY(%s) = id on annetussa listassa.
SELECTED_PLACEMENTS_SQL = "SELECT id, name, width, height FROM placements WHERE id = ANY(%s) ORDER BY name"

# Sijoitusten tallennus: jokaisesta valitusta paikasta yksi rivi (unnest purkaa listan).
# ON CONFLICT: jos mainos on jo samassa paikassa, rivi päivitetään (myös aiemmin
# poistettu eli inactive-sijoitus otetaan uudelleen käyttöön). Tyhjä alkamisaika =
# uudelle sijoitukselle nyt, olemassa olevalle sen nykyinen alkamisaika.
UPSERT_PLACINGS_SQL = """
INSERT INTO placings (advertiser_id, creative_id, campaign_id, placement_id,
                      weight, priority, start_time, end_time, status)
SELECT %(advertiser_id)s, %(creative_id)s, %(campaign_id)s, unnest(%(ids)s::int[]),
       %(weight)s, %(priority)s, COALESCE(%(start_time)s::timestamptz, now()), %(end_time)s, 'active'
ON CONFLICT (creative_id, placement_id) DO UPDATE SET
       advertiser_id = EXCLUDED.advertiser_id,
       campaign_id   = EXCLUDED.campaign_id,
       weight        = EXCLUDED.weight,
       priority      = EXCLUDED.priority,
       start_time    = COALESCE(%(start_time)s::timestamptz, placings.start_time),
       end_time      = EXCLUDED.end_time,
       status        = 'active'
"""

# Mainoksen sarakkeet creatives-taulussa (loput rungon kentät kuuluvat sijoituksille)
CREATIVE_FIELDS = {"advertiser_id", "name", "image_url", "target_url", "alt_text",
                   "width", "height", "status"}


def _prepare(conn, body: CreativeIn) -> tuple[dict, list[int]]:
    """Tarkistaa mainoksen ennen tallennusta ja palauttaa (mainoksen sarakkeet, paikkojen id:t).

    - Mainostaja on olemassa; kampanja (jos annettu) on olemassa ja samalla mainostajalla.
    - Jos kampanja on annettu, valittujen paikkojen on oltava kampanjan sallittuja paikkoja.
    - Mitat luetaan ladatusta kuvasta (ei luoteta lomakkeen arvoihin).
    - Mainospaikkoja on valittava vähintään yksi, ja niiden on oltava olemassa.
    - Kuvan kokoa ei rajata: mainostagi skaalaa isomman tai pienemmän kuvan paikan kokoon.
    Nostaa 422:n selkeällä suomenkielisellä viestillä, jos jokin ehto ei täyty.
    """
    if not conn.execute("SELECT 1 FROM advertisers WHERE id = %s", [body.advertiser_id]).fetchone():
        raise HTTPException(422, "Valittua mainostajaa ei löytynyt.")
    if body.campaign_id:
        camp = conn.execute("SELECT advertiser_id FROM campaigns WHERE id = %s", [body.campaign_id]).fetchone()
        if not camp:
            raise HTTPException(422, "Valittua kampanjaa ei löytynyt.")
        if camp["advertiser_id"] != body.advertiser_id:
            raise HTTPException(422, "Kampanja kuuluu eri mainostajalle kuin mainos. Valitse mainostajan kampanja.")

    data = body.model_dump(include=CREATIVE_FIELDS)
    size = local_image_size(conn, data["image_url"])
    if size:
        data["width"], data["height"] = size

    # dict.fromkeys poistaa tuplat mutta säilyttää järjestyksen
    ids = list(dict.fromkeys(body.placement_ids))
    if not ids:
        raise HTTPException(422, "Valitse vähintään yksi mainospaikka, jossa mainos näytetään.")
    places = conn.execute(SELECTED_PLACEMENTS_SQL, [ids]).fetchall()
    if len(places) != len(ids):
        raise HTTPException(422, "Valittua mainospaikkaa ei löytynyt. Päivitä sivu ja yritä uudelleen.")

    if body.campaign_id:
        allowed = {r["placement_id"] for r in conn.execute(
            "SELECT placement_id FROM campaign_placements WHERE campaign_id = %s", [body.campaign_id])}
        outside = [p["name"] for p in places if p["id"] not in allowed]
        if outside:
            raise HTTPException(
                422, "Mainospaikat eivät kuulu kampanjan mainospaikkoihin: " + ", ".join(outside)
                + ". Lisää ne kampanjaan Kampanjat-sivulla tai valitse kampanjan paikat.")

    return data, ids


def _save_placings(conn, creative_id: int, body: CreativeIn, ids: list[int]) -> None:
    """Tallentaa mainoksen sijoitukset: valitut paikat luodaan/päivitetään aktiivisiksi,
    valinnoista poistetut merkitään 'inactive'. Niitä ei poisteta, koska sijoituksen
    poisto poistaisi myös sen näyttö- ja klikkitilastot."""
    conn.execute(UPSERT_PLACINGS_SQL, {
        "advertiser_id": body.advertiser_id, "creative_id": creative_id,
        "campaign_id": body.campaign_id, "ids": ids, "weight": body.weight,
        "priority": body.priority, "start_time": body.start_time, "end_time": body.end_time,
    })
    conn.execute(
        "UPDATE placings SET status = 'inactive' WHERE creative_id = %s AND NOT (placement_id = ANY(%s))",
        [creative_id, ids],
    )


def _get_or_404(conn, creative_id: int):
    """Hakee yhden mainoksen listamuodossa (nimineen ja sijoituksineen), tai nostaa 404:n."""
    row = conn.execute(LIST_SQL, {"id": creative_id, "advertiser_id": None,
                                  "campaign_id": None, "unassigned": False}).fetchone()
    if not row:
        raise HTTPException(404, "Mainosta ei löytynyt.")
    return row


@router.post("/upload", status_code=201)
async def upload_image(request: Request):
    """Mainoskuvan lataus. Runko = kuvatiedosto sellaisenaan (Content-Type image/png
    tai image/jpeg). Palauttaa osoitteen, joka tallennetaan mainoksen image_url-kenttään.

    POST /api/creatives/upload. Vastaus (201): {image_url, width, height, bytes}.
    Virheet: 413 liian suuri tiedosto, 422 ei kelvollinen PNG/JPG tai tyhjä.
    Tiedostotyyppi tunnistetaan sisällöstä (media.inspect_image), ei otsakkeesta.

    Funktio on async, jotta rungon voi lukea (await request.body()). Tietokantakutsut
    ovat kuitenkin tavallisia (synkronisia), joten ne ajetaan run_in_threadpoolilla
    erillisessä säikeessä, jottei koko palvelin pysähdy odottamaan. Siksi yhteys
    otetaan suoraan poolista (with pool.connection()), ei Depends(get_conn)-riippuvuutena.
    """
    # Nopea ennakkotarkistus otsakkeesta ennen kuin koko runko luetaan muistiin.
    # (save_image tarkistaa koon vielä todellisesta datasta.)
    length = request.headers.get("content-length")
    if length and int(length) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"Kuva on liian suuri (enintään {MAX_UPLOAD_BYTES // (1024 * 1024)} Mt).")
    data = await request.body()

    def _save():
        with pool.connection() as conn:
            return save_image(conn, data)

    try:
        return await run_in_threadpool(_save)
    except InvalidImage as err:
        raise HTTPException(422, str(err))


@router.get("")
def list_creatives(campaign_id: int | None = None, advertiser_id: int | None = None,
                   unassigned: bool = False, conn=Depends(get_conn)):
    """GET /api/creatives[?campaign_id=..|?advertiser_id=..|?unassigned=true].

    campaign_id = mainokset, joilla on sijoitus kampanjassa; unassigned=true = mainokset
    ilman kampanjaa. Ilman parametreja kaikki mainokset. Palauttaa listan mainoksista
    mainostajan ja kampanjan nimineen sekä sijoitusten yhteenvedon (placements ym.).
    """
    return conn.execute(LIST_SQL, {"id": None, "advertiser_id": advertiser_id,
                                   "campaign_id": campaign_id, "unassigned": unassigned}).fetchall()


@router.get("/{creative_id}")
def get_creative(creative_id: int, conn=Depends(get_conn)):
    """GET /api/creatives/{creative_id} – yksi mainos. Virheet: 404 ei löydy."""
    return _get_or_404(conn, creative_id)


@router.post("", status_code=201)
def create_creative(body: CreativeIn, conn=Depends(get_conn)):
    """POST /api/creatives – luo mainoksen ja sen sijoitukset (kuva ladattu ensin /upload-reitillä).

    Runko: mainoksen tiedot + placement_ids (vähintään yksi) ja sijoitusten yhteiset
    asetukset (campaign_id, weight, priority, start_time, end_time).
    Palauttaa mainoksen listamuodossa (201). Virheet: 422 virheellinen runko, ei
    mainospaikkoja, kampanja eri mainostajalla tai mainos on paikkaa suurempi.
    """
    data, placement_ids = _prepare(conn, body)
    row = insert_row(conn, "creatives", data)
    _save_placings(conn, row["id"], body, placement_ids)
    return _get_or_404(conn, row["id"])


@router.put("/{creative_id}")
def update_creative(creative_id: int, body: CreativeIn, conn=Depends(get_conn)):
    """PUT /api/creatives/{creative_id} – päivittää mainoksen ja sen sijoitukset.

    Jos mainostaja vaihtuu, sijoitukset irrotetaan ensin vanhan mainostajan kampanjasta
    (tietokanta vaatii, että sijoituksen kampanja ja mainos ovat samalta mainostajalta);
    ON UPDATE CASCADE siirtää sijoitukset uudelle mainostajalle.
    Jos kuva vaihtui, vanha ladattu kuva poistetaan, ettei kantaan jää orpoja kuvia.
    Palauttaa päivitetyn mainoksen. Virheet: 404 ei löydy, muuten kuten luonnissa.
    """
    # Vanha rivi haetaan ensin, jotta tiedetään vanha kuva ja mainostaja.
    old = get_row(conn, "creatives", creative_id)
    if not old:
        raise HTTPException(404, "Mainosta ei löytynyt.")
    data, placement_ids = _prepare(conn, body)
    if old["advertiser_id"] != body.advertiser_id:
        conn.execute("UPDATE placings SET campaign_id = NULL WHERE creative_id = %s", [creative_id])
    update_row(conn, "creatives", creative_id, data)
    _save_placings(conn, creative_id, body, placement_ids)
    result = _get_or_404(conn, creative_id)
    if old["image_url"] != body.image_url:
        delete_local_image(conn, old["image_url"])   # samassa transaktiossa kuin tallennus
    return result


@router.delete("/{creative_id}", status_code=204)
def delete_creative(creative_id: int, conn=Depends(get_conn)):
    """DELETE /api/creatives/{creative_id} – poistaa mainoksen ja sen ladatun kuvan.

    Palauttaa 204. Virheet: 404 ei löydy. Mainoksen sijoitukset sekä niiden näyttö- ja
    klikkitilastot poistuvat myös (ON DELETE CASCADE); ulkoisiin kuva-URL:eihin ei kosketa.
    Käytöstä poistoon riittää tila 'inactive'.
    """
    old = get_row(conn, "creatives", creative_id)
    if not old or not delete_row(conn, "creatives", creative_id):
        raise HTTPException(404, "Mainosta ei löytynyt.")
    delete_local_image(conn, old["image_url"])
