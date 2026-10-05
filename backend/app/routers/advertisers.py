from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_admin
from ..db import delete_row, get_conn, insert_row, update_row
from ..schemas import AdvertiserIn

router = APIRouter(prefix="/api/advertisers", tags=["Mainostajat"])

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
    return conn.execute(LIST_SQL.format(where="")).fetchall()


@router.get("/{advertiser_id}")
def get_advertiser(advertiser_id: int, conn=Depends(get_conn)):
    row = conn.execute(LIST_SQL.format(where="WHERE a.id = %s"), [advertiser_id]).fetchone()
    if not row:
        raise HTTPException(404, "Mainostajaa ei löytynyt.")
    return row


@router.post("", status_code=201, dependencies=[Depends(require_admin)])
def create_advertiser(body: AdvertiserIn, conn=Depends(get_conn)):
    return insert_row(conn, "advertisers", body.model_dump())


@router.put("/{advertiser_id}", dependencies=[Depends(require_admin)])
def update_advertiser(advertiser_id: int, body: AdvertiserIn, conn=Depends(get_conn)):
    row = update_row(conn, "advertisers", advertiser_id, body.model_dump())
    if not row:
        raise HTTPException(404, "Mainostajaa ei löytynyt.")
    return row


@router.delete("/{advertiser_id}", status_code=204, dependencies=[Depends(require_admin)])
def delete_advertiser(advertiser_id: int, conn=Depends(get_conn)):
    # Mainostajaa, jolla on kampanjoita, ei voi poistaa (ON DELETE RESTRICT -> 409).
    if not delete_row(conn, "advertisers", advertiser_id):
        raise HTTPException(404, "Mainostajaa ei löytynyt.")
