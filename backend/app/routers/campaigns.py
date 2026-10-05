from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query

from ..db import delete_row, get_conn, insert_row, update_row
from ..schemas import CampaignIn, CampaignStatusIn

router = APIRouter(prefix="/api/campaigns", tags=["Kampanjat"])

# display_status: draft / active / paused / archived / pending (odottaa alkamista) / ended
LIST_SQL = """
SELECT c.*,
       a.name AS advertiser_name,
       COALESCE(
         json_agg(json_build_object('id', p.id, 'name', p.name, 'code', p.code)
                  ORDER BY p.name) FILTER (WHERE p.id IS NOT NULL),
         '[]') AS placements,
       (SELECT count(*) FROM creatives cr WHERE cr.campaign_id = c.id) AS creative_count
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
    params = {"id": None, "status": None, "advertiser_id": None, "q": None, **filters}
    return conn.execute(LIST_SQL, params).fetchall()


def _set_placements(conn, campaign_id: int, placement_ids: list[int]):
    conn.execute("DELETE FROM campaign_placements WHERE campaign_id = %s", [campaign_id])
    if placement_ids:
        conn.execute(
            """INSERT INTO campaign_placements (campaign_id, placement_id)
               SELECT %s, unnest(%s::int[]) ON CONFLICT DO NOTHING""",
            [campaign_id, list(set(placement_ids))],
        )


def _get_or_404(conn, campaign_id: int):
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
    return _fetch(conn, status=status, advertiser_id=advertiser_id, q=q or None)


@router.get("/{campaign_id}")
def get_campaign(campaign_id: int, conn=Depends(get_conn)):
    return _get_or_404(conn, campaign_id)


@router.post("", status_code=201)
def create_campaign(body: CampaignIn, conn=Depends(get_conn)):
    data = body.model_dump(exclude={"placement_ids"})
    row = insert_row(conn, "campaigns", data)
    _set_placements(conn, row["id"], body.placement_ids)
    return _get_or_404(conn, row["id"])


@router.put("/{campaign_id}")
def update_campaign(campaign_id: int, body: CampaignIn, conn=Depends(get_conn)):
    data = body.model_dump(exclude={"placement_ids"})
    if not update_row(conn, "campaigns", campaign_id, data):
        raise HTTPException(404, "Kampanjaa ei löytynyt.")
    _set_placements(conn, campaign_id, body.placement_ids)
    return _get_or_404(conn, campaign_id)


@router.patch("/{campaign_id}/status")
def set_campaign_status(campaign_id: int, body: CampaignStatusIn, conn=Depends(get_conn)):
    """Aktivointi / pausetus / arkistointi yhdellä napilla."""
    if not update_row(conn, "campaigns", campaign_id, {"status": body.status}):
        raise HTTPException(404, "Kampanjaa ei löytynyt.")
    return _get_or_404(conn, campaign_id)


@router.delete("/{campaign_id}", status_code=204)
def delete_campaign(campaign_id: int, conn=Depends(get_conn)):
    # Poistaa myös kampanjan mainokset ja tilastot (CASCADE).
    # Hallintapaneelissa kannattaa ensisijaisesti arkistoida.
    if not delete_row(conn, "campaigns", campaign_id):
        raise HTTPException(404, "Kampanjaa ei löytynyt.")
