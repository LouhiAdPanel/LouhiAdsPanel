"""Dashboard-luvut ja raportointi (luku 11) + CSV-vienti.

Endpointit (polun /api/stats alla):
  GET /api/stats/summary      -> dashboardin tunnusluvut (tänään)
  GET /api/stats/report       -> raportti JSONina, ryhmittely ja aikaväli valittavissa
  GET /api/stats/report.csv   -> sama raportti CSV-tiedostona
  GET /api/stats/report.xlsx  -> sama raportti Excel-tiedostona (sarakkeet ja päivät muotoiltu)

Oikeudet: kaikki kirjautuneet (main.py lisää kirjautumisvaatimuksen).

Liittyy: luvut lasketaan serving.py:n kirjaamista näytöistä (impressions) ja klikeistä
(clicks) näkymän v_daily_stats kautta (schema.sql), joka summaa ne päivittäin
(Suomen aika) sijoituksittain; sijoituksesta saadaan mainostaja, mainos, kampanja ja
mainospaikka. Raportin voi rajata mainostajaan ja/tai kampanjaan.
Näyttö kirjataan vasta, kun mainos on oikeasti näkynyt (serving.py). Kampanja voi puuttua (mainos ilman kampanjaa) -> raportissa
"(ei kampanjaa)". CTR = klikit / näytöt * 100.
Frontendissä dashboard.html (js/dashboard.js) ja reporting.html (js/reporting.js).
"""
import csv
import io
from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, Depends
from fastapi.responses import Response, StreamingResponse
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

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
    "advertiser": ("a.id, a.name",
                   "a.name AS advertiser"),
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
# advertiser_id ja campaign_id ovat valinnaisia suodattimia (NULL = kaikki).
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
  AND (%(advertiser_id)s::int IS NULL OR s.advertiser_id = %(advertiser_id)s)
  AND (%(campaign_id)s::int IS NULL OR s.campaign_id = %(campaign_id)s)
GROUP BY {group}
ORDER BY {order}
"""

GroupBy = Literal["advertiser", "campaign", "creative", "placement", "day"]


def _report(conn, group_by, start, end, campaign_id, advertiser_id=None):
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
        query, {"start": start, "end": end, "campaign_id": campaign_id,
                "advertiser_id": advertiser_id}
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
    advertiser_id: int | None = None,
    conn=Depends(get_conn),
):
    """Oletuksena viimeiset 30 päivää kampanjoittain.

    GET /api/stats/report?group_by=advertiser|campaign|creative|placement|day
    &start=YYYY-MM-DD&end=YYYY-MM-DD&advertiser_id=N&campaign_id=N (kaikki valinnaisia).
    Palauttaa listan rivejä: ryhmän nimikentät + impressions, clicks, ctr_percent.
    Virheet: 422 tuntematon group_by tai virheellinen päivämäärä.
    """
    return _report(conn, group_by, start, end, campaign_id, advertiser_id)


@router.get("/report.csv")
def report_csv(
    group_by: GroupBy = "campaign",
    start: date | None = None,
    end: date | None = None,
    campaign_id: int | None = None,
    advertiser_id: int | None = None,
    conn=Depends(get_conn),
):
    """GET /api/stats/report.csv – sama raportti ladattavana CSV-tiedostona.

    Parametrit ja virheet kuten /report. Erottimena puolipiste ja desimaalipilkku, koska
    suomenkielinen Excel olettaa ne. Jos Excelin kieliasetus on muu kuin suomi, arvot voivat
    osua samaan soluun: silloin kannattaa käyttää Excel-vientiä (/report.xlsx). Content-Disposition: attachment saa
    selaimen tallentamaan tiedoston näyttämisen sijaan. Ilman rivejä tiedostossa on vain BOM.
    """
    rows = _report(conn, group_by, start, end, campaign_id, advertiser_id)
    # CSV kirjoitetaan muistissa olevaan tekstipuskuriin ja lähetetään sieltä.
    buf = io.StringIO()
    buf.write("﻿")  # BOM, jotta Excel tunnistaa UTF-8:n (ä, ö)
    if rows:
        keys = list(rows[0].keys())
        writer = csv.writer(buf, delimiter=";")
        writer.writerow([COLUMN_LABELS.get(k, k) for k in keys])
        for r in rows:
            # Desimaalipilkku, jotta suomenkielinen Excel lukee CTR:n lukuna eikä tekstinä
            writer.writerow([str(r[k]).replace(".", ",") if k == "ctr_percent" and r[k] is not None
                             else r[k] for k in keys])
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="louhiads_{group_by}.csv"'},
    )


# Sarakkeiden otsikot CSV- ja Excel-vientiin (API:n kenttänimi -> suomenkielinen otsikko)
COLUMN_LABELS = {
    "advertiser": "Mainostaja", "campaign": "Kampanja", "creative": "Mainos",
    "placement": "Mainospaikka", "day": "Päivä",
    "impressions": "Näytöt", "clicks": "Klikit", "ctr_percent": "CTR",
}
GROUP_LABELS = {
    "advertiser": "Mainostajittain", "campaign": "Kampanjoittain", "creative": "Mainoksittain",
    "placement": "Mainospaikoittain", "day": "Päivittäin",
}


@router.get("/report.xlsx")
def report_xlsx(
    group_by: GroupBy = "campaign",
    start: date | None = None,
    end: date | None = None,
    campaign_id: int | None = None,
    advertiser_id: int | None = None,
    conn=Depends(get_conn),
):
    """GET /api/stats/report.xlsx – sama raportti Excel-tiedostona (.xlsx).

    Toisin kuin CSV, Excel-tiedosto aukeaa oikein kieliasetuksista riippumatta: jokainen arvo
    on omassa solussaan, luvut ovat lukuja, päivät päivämääriä (muoto p.k.vvvv), CTR
    prosenttilukuna ja sarakkeet riittävän leveitä (testauksessa CSV:n päivät näkyivät
    Excelissä muodossa ######). Toisella välilehdellä ovat raportin rajaukset.
    Parametrit ja virheet kuten /report.
    """
    end = end or date.today()
    start = start or end - timedelta(days=29)
    rows = _report(conn, group_by, start, end, campaign_id, advertiser_id)

    wb = Workbook()
    ws = wb.active
    ws.title = "Raportti"
    keys = list(rows[0].keys()) if rows else [*GROUPINGS_COLUMNS[group_by], "impressions", "clicks", "ctr_percent"]
    ws.append([COLUMN_LABELS.get(k, k) for k in keys])
    head_fill = PatternFill("solid", fgColor="FEF1DF")
    for c in ws[1]:
        c.font = Font(bold=True)
        c.fill = head_fill
    for r in rows:
        ws.append([float(r[k]) / 100 if k == "ctr_percent" and r[k] is not None else r[k] for k in keys])
    # Sarakemuodot: päivät, kokonaisluvut tuhaterottimin, CTR prosentteina
    for i, k in enumerate(keys, start=1):
        col = ws.cell(row=1, column=i).column_letter
        fmt = {"day": "d.m.yyyy", "impressions": "#,##0", "clicks": "#,##0", "ctr_percent": "0.00 %"}.get(k)
        for cell in ws[col][1:]:
            if fmt:
                cell.number_format = fmt
            if k in ("impressions", "clicks", "ctr_percent"):
                cell.alignment = Alignment(horizontal="right")
        longest = max([len(str(ws.cell(row=1, column=i).value))]
                      + [len(str(r[k])) for r in rows if r[k] is not None])
        ws.column_dimensions[col].width = min(max(longest + 3, 12), 60)
    if rows:
        total = len(rows) + 1
        ws.append([])
        sums = ["Yhteensä"] + [None] * (len(keys) - 1)
        ws.append(sums)
        last = ws.max_row
        for i, k in enumerate(keys, start=1):
            col = ws.cell(row=1, column=i).column_letter
            if k in ("impressions", "clicks"):
                ws.cell(row=last, column=i, value=f"=SUM({col}2:{col}{total})").number_format = "#,##0"
        imp = keys.index("impressions") + 1
        clk = keys.index("clicks") + 1
        ctr = keys.index("ctr_percent") + 1
        ic = ws.cell(row=1, column=imp).column_letter
        cc = ws.cell(row=1, column=clk).column_letter
        ws.cell(row=last, column=ctr, value=f"=IF({ic}{last}=0,\"\",{cc}{last}/{ic}{last})").number_format = "0.00 %"
        for c in ws[last]:
            c.font = Font(bold=True)
    ws.freeze_panes = "A2"

    # Välilehti 2: mitä raportti sisältää (rajaukset tulostusta ja jakamista varten)
    info = wb.create_sheet("Tiedot")
    adv = conn.execute("SELECT name FROM advertisers WHERE id = %s", [advertiser_id]).fetchone() if advertiser_id else None
    camp = conn.execute("SELECT name FROM campaigns WHERE id = %s", [campaign_id]).fetchone() if campaign_id else None
    for label, value in [
        ("Louhi Ads -raportti", None),
        ("Ajanjakso", f"{start.day}.{start.month}.{start.year}–{end.day}.{end.month}.{end.year}"),
        ("Ryhmittely", GROUP_LABELS[group_by]),
        ("Mainostaja", adv["name"] if adv else "Kaikki mainostajat"),
        ("Kampanja", camp["name"] if camp else "Kaikki kampanjat"),
        ("Näyttö", "Kirjataan, kun vähintään puolet mainoksesta on näkynyt sekunnin."),
        ("CTR", "Klikit / näytöt"),
    ]:
        info.append([label, value])
    info["A1"].font = Font(bold=True, size=13)
    for c in info["A"][1:]:
        c.font = Font(bold=True)
    info.column_dimensions["A"].width = 16
    info.column_dimensions["B"].width = 70

    buf = io.BytesIO()
    wb.save(buf)
    return Response(
        buf.getvalue(),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="louhiads_{group_by}_{start}_{end}.xlsx"'},
    )


# Ryhmittelyn nimisarakkeet tyhjälle raportille (sama järjestys kuin GROUPINGS-kyselyssä)
GROUPINGS_COLUMNS = {
    "advertiser": ["advertiser"],
    "campaign": ["campaign", "advertiser"],
    "creative": ["creative", "advertiser", "campaign"],
    "placement": ["placement"],
    "day": ["day"],
}
