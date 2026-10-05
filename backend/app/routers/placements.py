from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_admin
from ..db import delete_row, get_conn, insert_row, update_row
from ..schemas import PlacementIn
from ..slug import unique_code

router = APIRouter(prefix="/api/placements", tags=["Mainospaikat"])

LIST_SQL = """
SELECT p.*,
       count(c.id) FILTER (WHERE c.display_status = 'active') AS active_campaign_count
FROM placements p
LEFT JOIN campaign_placements cp ON cp.placement_id = p.id
LEFT JOIN v_campaign_status c    ON c.id = cp.campaign_id
{where}
GROUP BY p.id
ORDER BY p.name
"""


@router.get("")
def list_placements(conn=Depends(get_conn)):
    return conn.execute(LIST_SQL.format(where="")).fetchall()


@router.get("/{placement_id}")
def get_placement(placement_id: int, conn=Depends(get_conn)):
    row = conn.execute(LIST_SQL.format(where="WHERE p.id = %s"), [placement_id]).fetchone()
    if not row:
        raise HTTPException(404, "Mainospaikkaa ei löytynyt.")
    return row


@router.post("", status_code=201, dependencies=[Depends(require_admin)])
def create_placement(body: PlacementIn, conn=Depends(get_conn)):
    data = body.model_dump()
    if not data["code"]:
        existing = {r["code"] for r in conn.execute("SELECT code FROM placements").fetchall()}
        data["code"] = unique_code(body.name, existing)
    return insert_row(conn, "placements", data)


@router.put("/{placement_id}", dependencies=[Depends(require_admin)])
def update_placement(placement_id: int, body: PlacementIn, conn=Depends(get_conn)):
    # Placement ID:tä ei muuteta: se on jo upotettu sivustoille (data-placement="...").
    row = update_row(conn, "placements", placement_id, body.model_dump(exclude={"code"}))
    if not row:
        raise HTTPException(404, "Mainospaikkaa ei löytynyt.")
    return row


@router.delete("/{placement_id}", status_code=204, dependencies=[Depends(require_admin)])
def delete_placement(placement_id: int, conn=Depends(get_conn)):
    if not delete_row(conn, "placements", placement_id):
        raise HTTPException(404, "Mainospaikkaa ei löytynyt.")
