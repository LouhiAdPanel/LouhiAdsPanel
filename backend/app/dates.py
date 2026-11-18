"""Päivämäärien yhteiset säännöt (kampanjat ja mainokset).

Aloitus- ja päättymispäivä eivät saa olla menneisyydessä: muuten kampanja tai mainos
voisi vahingossa jäädä kokonaan näkymättä tai sen näkyvyysaika lyhenisi (virhe, joka
kirjattiin projektin dokumentaatioon). Päivää verrataan Suomen ajassa, jotta
"tänään" vaihtuu keskiyöllä paikallista aikaa. Tämä päivä on sallittu.

Poikkeus: jo tallennettu päivä saa jäädä ennalleen, vaikka se olisi mennyt. Muuten
käynnissä olevaa kampanjaa (alkanut eilen) tai päättynyttä kampanjaa ei voisi enää
muokata lainkaan. Sääntö koskee siis vain uutta tai muutettua päivää.

Vertailu tehdään tietokannassa (AT TIME ZONE 'Europe/Helsinki'), koska Windowsin
Pythonissa ei ole aikavyöhyketietokantaa ilman lisäpakettia.
Käyttäjät: routers/campaigns.py ja routers/creatives.py. Sama sääntö on lomakkeilla
(js/campaigns.js, js/creatives.js), jolloin käyttäjä saa virheen heti kentän alle.
"""
from datetime import datetime

from fastapi import HTTPException

# past = uusi päivä on ennen tätä päivää; same = päivä on sama kuin tallennettu
PAST_SQL = """
SELECT (%(new)s::timestamptz AT TIME ZONE 'Europe/Helsinki')::date
         < (now() AT TIME ZONE 'Europe/Helsinki')::date AS past,
       (%(new)s::timestamptz AT TIME ZONE 'Europe/Helsinki')::date
         IS NOT DISTINCT FROM (%(old)s::timestamptz AT TIME ZONE 'Europe/Helsinki')::date AS same
"""


def check_not_past(conn, new: datetime | None, old: datetime | None, message: str) -> None:
    """Nostaa 422:n, jos uusi tai muutettu päivä on menneisyydessä. Tyhjä päivä kelpaa."""
    if new is None:
        return
    row = conn.execute(PAST_SQL, {"new": new, "old": old}).fetchone()
    if row["past"] and not row["same"]:
        raise HTTPException(422, message)
