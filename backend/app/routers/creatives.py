from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.concurrency import run_in_threadpool

from ..db import delete_row, get_conn, get_row, insert_row, pool, update_row
from ..media import MAX_UPLOAD_BYTES, InvalidImage, delete_local_image, local_image_size, save_image
from ..schemas import CreativeIn

router = APIRouter(prefix="/api/creatives", tags=["Mainokset"])

LIST_SQL = """
SELECT cr.*,
       c.name AS campaign_name,
       a.id   AS advertiser_id,
       a.name AS advertiser_name
FROM creatives cr
LEFT JOIN campaigns c   ON c.id = cr.campaign_id      -- kampanja on valinnainen
LEFT JOIN advertisers a ON a.id = c.advertiser_id
WHERE (%(id)s::int          IS NULL OR cr.id = %(id)s)
  AND (%(campaign_id)s::int IS NULL OR cr.campaign_id = %(campaign_id)s)
  AND (NOT %(unassigned)s OR cr.campaign_id IS NULL)
ORDER BY a.name NULLS FIRST, c.name NULLS FIRST, cr.name
"""

# Mainospaikat, joihin mainos voisi päätyä: kampanjan paikat, tai ilman kampanjaa kaikki aktiiviset.
CANDIDATE_PLACEMENTS_SQL = """
SELECT p.name, p.width, p.height
FROM placements p
WHERE CASE WHEN %(campaign_id)s::int IS NULL THEN p.status = 'active'
           ELSE p.id IN (SELECT placement_id FROM campaign_placements WHERE campaign_id = %(campaign_id)s)
      END
ORDER BY p.width * p.height DESC
"""


def _prepare(conn, body: CreativeIn) -> dict:
    """Mitat luetaan ladatusta kuvasta (ei luoteta lomakkeen arvoihin) ja tarkistetaan,
    että mainos mahtuu vähintään yhteen mainospaikkaan. Mainospaikan koko = maksimikoko."""
    data = body.model_dump()
    size = local_image_size(conn, data["image_url"])
    if size:
        data["width"], data["height"] = size
    w, h = data["width"], data["height"]
    if not (w and h):
        return data  # ulkoinen kuva ilman mittoja: ei voida tarkistaa

    places = conn.execute(CANDIDATE_PLACEMENTS_SQL, {"campaign_id": data["campaign_id"]}).fetchall()
    if places and not any(w <= p["width"] and h <= p["height"] for p in places):
        limits = ", ".join(f'{p["name"]} {p["width"]}×{p["height"]}' for p in places[:5])
        where = "kampanjan mainospaikkoihin" if data["campaign_id"] else "yhteenkään aktiiviseen mainospaikkaan"
        raise HTTPException(
            422, f"Mainos ({w}×{h} px) ei mahdu {where}. Mainospaikkojen maksimikoot: {limits}."
        )
    return data


def _get_or_404(conn, creative_id: int):
    row = conn.execute(LIST_SQL, {"id": creative_id, "campaign_id": None, "unassigned": False}).fetchone()
    if not row:
        raise HTTPException(404, "Mainosta ei löytynyt.")
    return row


@router.post("/upload", status_code=201)
async def upload_image(request: Request):
    """Mainoskuvan lataus. Runko = kuvatiedosto sellaisenaan (Content-Type image/png
    tai image/jpeg). Palauttaa osoitteen, joka tallennetaan mainoksen image_url-kenttään."""
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
def list_creatives(campaign_id: int | None = None, unassigned: bool = False, conn=Depends(get_conn)):
    """campaign_id = yhden kampanjan mainokset, unassigned=true = mainokset ilman kampanjaa."""
    return conn.execute(
        LIST_SQL, {"id": None, "campaign_id": campaign_id, "unassigned": unassigned}
    ).fetchall()


@router.get("/{creative_id}")
def get_creative(creative_id: int, conn=Depends(get_conn)):
    return _get_or_404(conn, creative_id)


@router.post("", status_code=201)
def create_creative(body: CreativeIn, conn=Depends(get_conn)):
    row = insert_row(conn, "creatives", _prepare(conn, body))
    return _get_or_404(conn, row["id"])


@router.put("/{creative_id}")
def update_creative(creative_id: int, body: CreativeIn, conn=Depends(get_conn)):
    old = get_row(conn, "creatives", creative_id)
    if not old:
        raise HTTPException(404, "Mainosta ei löytynyt.")
    update_row(conn, "creatives", creative_id, _prepare(conn, body))
    result = _get_or_404(conn, creative_id)
    if old["image_url"] != body.image_url:
        delete_local_image(conn, old["image_url"])   # samassa transaktiossa kuin tallennus
    return result


@router.delete("/{creative_id}", status_code=204)
def delete_creative(creative_id: int, conn=Depends(get_conn)):
    old = get_row(conn, "creatives", creative_id)
    if not old or not delete_row(conn, "creatives", creative_id):
        raise HTTPException(404, "Mainosta ei löytynyt.")
    delete_local_image(conn, old["image_url"])
