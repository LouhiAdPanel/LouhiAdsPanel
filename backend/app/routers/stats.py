"""Dashboard-luvut ja raportointi (luku 11) + CSV-vienti.

Endpointit (polun /api/stats alla):
  GET /api/stats/summary      -> dashboardin tunnusluvut (tänään)
  GET /api/stats/report       -> raportti JSONina, ryhmittely ja aikaväli valittavissa
  GET /api/stats/report.csv   -> sama raportti CSV-tiedostona (Excel)

Oikeudet: kaikki kirjautuneet (main.py lisää kirjautumisvaatimuksen).

Liittyy: luvut lasketaan serving.py:n kirjaamista näytöistä (impressions) ja klikeistä
(clicks) näkymän v_daily_stats kautta (schema.sql), joka summaa ne päivittäin
(Suomen aika) sijoituksittain; sijoituksesta saadaan mainostaja, mainos, kampanja ja
mainospaikka. Kampanja voi puuttua (mainos ilman kampanjaa) -> raportissa
"(ei kampanjaa)". CTR = klikit / näytöt * 100.
Frontendissä dashboard.html (js/dashboard.js) ja reporting.html (js/reporting.js).
"""
import csv
import io
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from ..db import get_conn

router = APIRouter(prefix="/api/stats", tags=["Raportointi"])

# Dashboardin luvut yhdellä rivillä: aktiivisten kampanjoiden määrä (alikysely) sekä
# tämän päivän näytöt, klikit ja CTR-prosentti. "Tänään" lasketaan Suomen ajassa, jotta
# päivä vaihtuu keskiyöllä paikallista aikaa eikä UTC:n mukaan.
# COALESCE(..., 0): ilman dataa sum() antaa NULL -> näytetään 0.
# NULLIF(..., 0): jakaja 0 muutetaan NULLiksi, jolloin CTR on NULL eikä tule nollalla
# jakamisen virhettä.
SUMMARY_SQL = """
SELECT
  (SELECT count(*) FROM v_campaign_status WHERE display_status = 'active') AS active_campaigns,
  COALESCE(sum(impressions), 0) AS impressions_today,
  COALESCE(sum(clicks), 0)      AS clicks_today,
  ROUND(100.0 * COALESCE(sum(clicks), 0) / NULLIF(sum(impressions), 0), 2) AS ctr_today
FROM v_daily_stats
WHERE day = (now() AT TIME ZONE 'Europe/Helsinki')::date
"""

# Nimi kampanjattomille riveille (sijoitus ilman kampanjaa)
NO_CAMPAIGN = "(ei kampanjaa)"

# Ryhmittelyvaihtoehdot. Avaimet tulevat whitelististä, ei suoraan käyttäjältä SQL:ään.
# Arvo = (GROUP BY -osa, SELECT-osa). Ryhmittelyssä on mukana id, jotta samannimiset
# kampanjat/mainokset eivät yhdisty yhdeksi riviksi.
GROUPINGS = {
    "campaign":  ("c.id, c.name, a.name",
                  f"COALESCE(c.name, '{NO_CAMPAIGN}') AS campaign, a.name AS advertiser"),
    "creative":  ("cr.id, cr.name, a.name, c.name",
                  f"cr.name AS creative, a.name AS advertiser, COALESCE(c.name, '{NO_CAMPAIGN}') AS campaign"),
    "placement": ("p.id, p.name",
                  "p.name AS placement"),
    "day":       ("s.day",
                  "s.day"),
}

# Raporttikysely. Päivittäiset luvut (v_daily_stats) yhdistetään nimitietoihin ja
# summataan valitun ryhmittelyn mukaan. {select}, {group} ja {order} täytetään
# GROUPINGS-taulukosta (ks. _report); käyttäjän arvot (päivät, kampanja) kulkevat
# %(nimi)s-parametreina. Aikaväli on molemmista päistä mukaan luettu (BETWEEN).
# campaign_id on valinnainen suodatin (NULL = kaikki kampanjat).
REPORT_SQL = """
SELECT {select},
       sum(s.impressions) AS impressions,
       sum(s.clicks)      AS clicks,
       ROUND(100.0 * sum(s.clicks) / NULLIF(sum(s.impressions), 0), 2) AS ctr_percent
FROM v_daily_stats s
JOIN advertisers a    ON a.id  = s.advertiser_id
LEFT JOIN campaigns c ON c.id  = s.campaign_id       -- kampanja on valinnainen
JOIN creatives cr     ON cr.id = s.creative_id
JOIN placements p     ON p.id  = s.placement_id
WHERE s.day BETWEEN %(start)s AND %(end)s
  AND (%(campaign_id)s::int IS NULL OR s.campaign_id = %(campaign_id)s)
GROUP BY {group}
ORDER BY {order}
"""

GroupBy = Literal["campaign", "creative", "placement", "day"]


def _report(conn, group_by, start, end, campaign_id):
    """Yhteinen toteutus JSON- ja CSV-raportille.

    Oletusaikaväli: 30 päivää tähän päivään asti (alku = loppu - 29 pv, molemmat mukana).
    Päiväryhmittely järjestetään päivän mukaan, muut näyttömäärän mukaan suurin ensin.
    """
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
    """Dashboardin luvut: aktiiviset kampanjat, tämän päivän näytöt/klikit/CTR.

    GET /api/stats/summary. Palauttaa {active_campaigns, impressions_today,
    clicks_today, ctr_today}; ctr_today on null, jos näyttöjä ei ole.
    """
    return conn.execute(SUMMARY_SQL).fetchone()


@router.get("/report")
def report(
    group_by: GroupBy = "campaign",
    start: date | None = None,
    end: date | None = None,
    campaign_id: int | None = None,
    conn=Depends(get_conn),
):
    """Oletuksena viimeiset 30 päivää kampanjoittain.

    GET /api/stats/report?group_by=campaign|creative|placement|day&start=YYYY-MM-DD
    &end=YYYY-MM-DD&campaign_id=N (kaikki valinnaisia).
    Palauttaa listan rivejä: ryhmän nimikentät + impressions, clicks, ctr_percent.
    Virheet: 422 tuntematon group_by tai virheellinen päivämäärä.
    """
    return _report(conn, group_by, start, end, campaign_id)


@router.get("/report.csv")
def report_csv(
    group_by: GroupBy = "campaign",
    start: date | None = None,
    end: date | None = None,
    campaign_id: int | None = None,
    conn=Depends(get_conn),
):
    """GET /api/stats/report.csv – sama raportti ladattavana CSV-tiedostona.

    Parametrit ja virheet kuten /report. Erottimena puolipiste, koska suomenkielinen
    Excel olettaa sen (pilkku on desimaalierotin). Content-Disposition: attachment saa
    selaimen tallentamaan tiedoston näyttämisen sijaan. Ilman rivejä tiedostossa on vain BOM.
    """
    rows = _report(conn, group_by, start, end, campaign_id)
    # CSV kirjoitetaan muistissa olevaan tekstipuskuriin ja lähetetään sieltä.
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
