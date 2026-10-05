from fastapi import APIRouter, Depends, HTTPException, Request

from ..db import delete_row, get_conn, get_row, insert_row, update_row
from ..media import MAX_UPLOAD_BYTES, InvalidImage, delete_local_image, save_image
from ..schemas import CreativeIn

router = APIRouter(prefix="/api/creatives", tags=["Mainokset"])

LIST_SQL = """
SELECT cr.*,
       c.name AS campaign_name,
       a.id   AS advertiser_id,
       a.name AS advertiser_name
FROM creatives cr
JOIN campaigns c   ON c.id = cr.campaign_id
JOIN advertisers a ON a.id = c.advertiser_id
WHERE (%(id)s::int          IS NULL OR cr.id = %(id)s)
  AND (%(campaign_id)s::int IS NULL OR cr.campaign_id = %(campaign_id)s)
ORDER BY a.name, c.name, cr.name
"""


def _get_or_404(conn, creative_id: int):
    row = conn.execute(LIST_SQL, {"id": creative_id, "campaign_id": None}).fetchone()
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
    try:
        return save_image(data)
    except InvalidImage as err:
        raise HTTPException(422, str(err))


@router.get("")
def list_creatives(campaign_id: int | None = None, conn=Depends(get_conn)):
    return conn.execute(LIST_SQL, {"id": None, "campaign_id": campaign_id}).fetchall()


@router.get("/{creative_id}")
def get_creative(creative_id: int, conn=Depends(get_conn)):
    return _get_or_404(conn, creative_id)


@router.post("", status_code=201)
def create_creative(body: CreativeIn, conn=Depends(get_conn)):
    row = insert_row(conn, "creatives", body.model_dump())
    return _get_or_404(conn, row["id"])


@router.put("/{creative_id}")
def update_creative(creative_id: int, body: CreativeIn, conn=Depends(get_conn)):
    old = get_row(conn, "creatives", creative_id)
    if not old:
        raise HTTPException(404, "Mainosta ei löytynyt.")
    update_row(conn, "creatives", creative_id, body.model_dump())
    result = _get_or_404(conn, creative_id)
    if old["image_url"] != body.image_url:
        conn.commit()                         # poistetaan vanha kuva vasta kun tallennus onnistui
        delete_local_image(old["image_url"])
    return result


@router.delete("/{creative_id}", status_code=204)
def delete_creative(creative_id: int, conn=Depends(get_conn)):
    old = get_row(conn, "creatives", creative_id)
    if not old or not delete_row(conn, "creatives", creative_id):
        raise HTTPException(404, "Mainosta ei löytynyt.")
    conn.commit()
    delete_local_image(old["image_url"])
