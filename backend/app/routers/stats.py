"""Dashboard-luvut ja raportointi (luku 11) + CSV-vienti."""
import csv
import io
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..db import get_conn

router = APIRouter(prefix="/api/stats", tags=["Raportointi"])

SUMMARY_SQL = """
SELECT
  (SELECT count(*) FROM v_campaign_status WHERE display_status = 'active') AS active_campaigns,
  COALESCE(sum(impressions), 0) AS impressions_today,
  COALESCE(sum(clicks), 0)      AS clicks_today,
  ROUND(100.0 * COALESCE(sum(clicks), 0) / NULLIF(sum(impressions), 0), 2) AS ctr_today
FROM v_daily_stats
WHERE day = (now() AT TIME ZONE 'Europe/Helsinki')::date
"""

# Ryhmittelyvaihtoehdot. Avaimet tulevat whitelististä, ei suoraan käyttäjältä SQL:ään.
GROUPINGS = {
    "campaign":  ("c.id, c.name, a.name",
                  "c.name AS campaign, a.name AS advertiser"),
    "creative":  ("cr.id, cr.name, c.name",
                  "cr.name AS creative, c.name AS campaign"),
    "placement": ("p.id, p.name",
                  "p.name AS placement"),
    "day":       ("s.day",
                  "s.day"),
}

REPORT_SQL = """
SELECT {select},
       sum(s.impressions) AS impressions,
       sum(s.clicks)      AS clicks,
       ROUND(100.0 * sum(s.clicks) / NULLIF(sum(s.impressions), 0), 2) AS ctr_percent
FROM v_daily_stats s
JOIN campaigns c   ON c.id  = s.campaign_id
JOIN advertisers a ON a.id  = c.advertiser_id
JOIN creatives cr  ON cr.id = s.creative_id
JOIN placements p  ON p.id  = s.placement_id
WHERE s.day BETWEEN %(start)s AND %(end)s
  AND (%(campaign_id)s::int IS NULL OR s.campaign_id = %(campaign_id)s)
GROUP BY {group}
ORDER BY {order}
"""

GroupBy = Literal["campaign", "creative", "placement", "day"]


def _report(conn, group_by, start, end, campaign_id):
    end = end or date.today()
    start = start or end - timedelta(days=29)
    group, select = GROUPINGS[group_by]
    order = "s.day" if group_by == "day" else "impressions DESC"
    query = REPORT_SQL.format(select=select, group=group, order=order)
    return conn.execute(
        query, {"start": start, "end": end, "campaign_id": campaign_id}
    ).fetchall()


@router.get("/summary")
def summary(conn=Depends(get_conn)):
    """Dashboardin luvut: aktiiviset kampanjat, tämän päivän näytöt/klikit/CTR."""
    return conn.execute(SUMMARY_SQL).fetchone()


@router.get("/report")
def report(
    group_by: GroupBy = "campaign",
    start: date | None = None,
    end: date | None = None,
    campaign_id: int | None = None,
    conn=Depends(get_conn),
):
    """Oletuksena viimeiset 30 päivää kampanjoittain."""
    return _report(conn, group_by, start, end, campaign_id)


@router.get("/report.csv")
def report_csv(
    group_by: GroupBy = "campaign",
    start: date | None = None,
    end: date | None = None,
    campaign_id: int | None = None,
    conn=Depends(get_conn),
):
    rows = _report(conn, group_by, start, end, campaign_id)
    buf = io.StringIO()
    buf.write("﻿")  # BOM, jotta Excel tunnistaa UTF-8:n (ä, ö)
    if rows:
        writer = csv.DictWriter(buf, fieldnames=list(rows[0].keys()), delimiter=";")
        writer.writeheader()
        writer.writerows(rows)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="louhiads_{group_by}.csv"'},
    )
