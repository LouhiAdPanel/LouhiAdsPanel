"""Mainosten jakelu (määrittely luvut 4, 10 ja 12).

GET /api/v1/ad?placement=<code>      -> mainos JSONina tai 204 No Content
GET /api/v1/click/{creative_id}       -> rekisteröi klikin ja 302-ohjaus kohdesivulle
"""
import random
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from fastapi import APIRouter, Depends, Query, Request, Response
from fastapi.responses import JSONResponse, RedirectResponse

from ..db import get_conn

router = APIRouter(prefix="/api/v1", tags=["Mainosten jakelu"])

NO_CACHE = {"Cache-Control": "no-store"}

# Luku 10, kohdat 1–5: aktiivinen mainospaikka -> aktiiviset, käynnissä olevat
# kampanjat -> niiden aktiiviset mainokset, joiden paino > 0.
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
"""
# Kohdennussäännöt (targeting_rules) lisätään tähän myöhemmin (luku 9).


@router.get("/ad")
def get_ad(
    request: Request,
    placement: str = Query(min_length=1, max_length=64, description="Placement ID"),
    conn=Depends(get_conn),
):
    candidates = conn.execute(ELIGIBLE_SQL, [placement]).fetchall()
    if not candidates:
        return Response(status_code=204, headers=NO_CACHE)

    # Korkeimman prioriteetin kampanjat ensin (oletuksena kaikilla 0 = ei vaikutusta),
    # sitten painotettu satunnaisvalinta (luku 8).
    top = max(c["priority"] for c in candidates)
    candidates = [c for c in candidates if c["priority"] == top]
    ad = random.choices(candidates, weights=[c["weight"] for c in candidates], k=1)[0]

    conn.execute(
        "INSERT INTO impressions (campaign_id, creative_id, placement_id) VALUES (%s, %s, %s)",
        [ad["campaign_id"], ad["creative_id"], ad["placement_id"]],
    )

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
    """Lisää UTM-parametrit, ellei kohdeosoitteessa ole niitä jo."""
    parts = urlsplit(url)
    query = dict(parse_qsl(parts.query, keep_blank_values=True))
    query.setdefault("utm_source", "louhi")
    query.setdefault("utm_medium", "internal_display")
    query.setdefault("utm_campaign", campaign)
    return urlunsplit(parts._replace(query=urlencode(query)))


@router.get("/click/{creative_id}", name="click")
def click(creative_id: int, placement: int | None = None, conn=Depends(get_conn)):
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
    if placement is not None:
        conn.execute(
            """INSERT INTO clicks (campaign_id, creative_id, placement_id)
               SELECT %s, %s, p.id FROM placements p WHERE p.id = %s""",
            [row["campaign_id"], creative_id, placement],
        )

    return RedirectResponse(
        _add_utm(row["target_url"], row["utm_campaign"]), status_code=302, headers=NO_CACHE
    )
