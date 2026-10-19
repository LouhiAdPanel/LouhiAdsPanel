"""Mainospaikat (placements) – Mainospaikat-sivu (placements.html).

Mainospaikka on sivuston kohta, johon mainos näytetään (esim. etusivun banneri).
Jokaisella paikalla on yksilöllinen code ("placement ID"), jonka sivusto upottaa
mainostagiin (data-placement="..."); jakelu (serving.py) hakee mainoksen sen perusteella.
Paikan leveys ja korkeus ovat suurin sallittu mainoksen koko.

Endpointit (polun /api/placements alla):
  GET    /api/placements          -> kaikki mainospaikat + aktiivisten kampanjoiden määrä
  GET    /api/placements/{id}     -> yksi mainospaikka
  POST   /api/placements          -> uusi mainospaikka         (vain admin)
  PUT    /api/placements/{id}     -> päivitys (code ei muutu)  (vain admin)
  DELETE /api/placements/{id}     -> poisto                    (vain admin)

Oikeudet: lukeminen kaikille kirjautuneille (kampanjalomake tarvitsee paikkalistan),
kirjoittaminen vain adminille.
"""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_admin
from ..db import delete_row, get_conn, insert_row, update_row
from ..schemas import PlacementIn
from ..slug import unique_code

router = APIRouter(prefix="/api/placements", tags=["Mainospaikat"])


def normalize_name(name: str) -> str:
    """Nimi siistittynä tallennusta varten: reunojen välilyönnit pois ja peräkkäiset
    välilyönnit yhdeksi ("  Demo   hero " -> "Demo hero")."""
    return " ".join(name.split())


# Nimen vertailu: kirjainkoolla ja ylimääräisillä välilyönneillä ei ole väliä, eli
# "Demo hero", "demo HERO" ja "Demo  hero" ovat sama nimi. Sama sääntö on lomakkeella
# (placements.js, nameKey). Muokattava paikka itse jätetään vertailusta pois (id <> %s).
SAME_NAME_SQL = """
SELECT name FROM placements
WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower(%s)
  AND id <> %s
LIMIT 1
"""


def _check_unique_name(conn, name: str, exclude_id: int = -1) -> None:
    """Estää kaksi samannimistä mainospaikkaa (409). Samannimiset paikat on helppo
    sekoittaa toisiinsa esim. mainosta sijoitettaessa."""
    row = conn.execute(SAME_NAME_SQL, [name, exclude_id]).fetchone()
    if row:
        raise HTTPException(
            409, f"Mainospaikka nimellä \"{row['name']}\" on jo olemassa. Anna paikalle eri nimi.")

# Mainospaikat ja kuinka monta aktiivista sijoitusta (mainosta) kuhunkin on liitetty.
# Reitti: placements -> placings (sijoitukset). LEFT JOIN pitää mukana paikat, joilla
# ei ole sijoituksia; FILTER laskee vain aktiiviset.
# {where} täytetään .format():lla kuten advertisers.py:ssä (arvo silti %s-parametrina).
LIST_SQL = """
SELECT p.*,
       count(pl.id) FILTER (WHERE pl.status = 'active') AS active_placing_count
FROM placements p
LEFT JOIN placings pl ON pl.placement_id = p.id
{where}
GROUP BY p.id
ORDER BY p.name
"""


@router.get("")
def list_placements(conn=Depends(get_conn)):
    """GET /api/placements – kaikki mainospaikat nimen mukaan järjestettynä."""
    return conn.execute(LIST_SQL.format(where="")).fetchall()


@router.get("/{placement_id}")
def get_placement(placement_id: int, conn=Depends(get_conn)):
    """GET /api/placements/{placement_id} – yksi mainospaikka. Virheet: 404 ei löydy."""
    row = conn.execute(LIST_SQL.format(where="WHERE p.id = %s"), [placement_id]).fetchone()
    if not row:
        raise HTTPException(404, "Mainospaikkaa ei löytynyt.")
    return row


@router.post("", status_code=201, dependencies=[Depends(require_admin)])
def create_placement(body: PlacementIn, conn=Depends(get_conn)):
    """POST /api/placements – luo mainospaikan (vain admin).

    Lomake ehdottaa koodia nimestä (Koodi-kenttä), mutta käyttäjä voi muuttaa sitä.
    Jos code jätetään tyhjäksi, se muodostetaan nimestä (slug.unique_code), esim.
    "Etusivu ylä" -> "louhi_etusivu_yla" (varattu -> "louhi_etusivu_yla_2").
    Nimen on oltava yksilöllinen (kirjainkoosta ja välilyönneistä riippumatta).
    Palauttaa luodun rivin (201). Virheet: 403 ei-admin, 409 nimi tai code jo käytössä,
    422 virheellinen runko.
    """
    data = body.model_dump()
    data["name"] = normalize_name(data["name"])
    _check_unique_name(conn, data["name"])
    if data["code"] and conn.execute("SELECT 1 FROM placements WHERE code = %s", [data["code"]]).fetchone():
        raise HTTPException(409, f"Koodi {data['code']} on jo käytössä. Valitse toinen koodi.")
    if not data["code"]:
        # Haetaan olemassa olevat koodit, jotta uusi ei törmää niihin.
        existing = {r["code"] for r in conn.execute("SELECT code FROM placements").fetchall()}
        data["code"] = unique_code(body.name, existing)
    return insert_row(conn, "placements", data)


@router.put("/{placement_id}", dependencies=[Depends(require_admin)])
def update_placement(placement_id: int, body: PlacementIn, conn=Depends(get_conn)):
    """PUT /api/placements/{placement_id} – päivittää nimen, koon, tilan ym. (vain admin).

    Rungon code-kenttä ohitetaan. Vain rungossa annetut kentät päivitetään
    (exclude_unset), joten esim. lomakkeelta puuttuvat tekniset huomiot (notes) säilyvät.
    Palauttaa päivitetyn rivin.
    Virheet: 403 ei-admin, 404 ei löydy, 409 nimi jo toisella paikalla, 422 virheellinen runko.
    """
    data = body.model_dump(exclude={"code"}, exclude_unset=True)
    if "name" in data:
        data["name"] = normalize_name(data["name"])
        # Nimi tarkistetaan vain, jos se muuttuu: näin vanhan (ennen tätä sääntöä
        # syntyneen) samannimisen paikan muita tietoja voi yhä muokata.
        current = conn.execute("SELECT name FROM placements WHERE id = %s", [placement_id]).fetchone()
        if current and normalize_name(current["name"]).lower() != data["name"].lower():
            _check_unique_name(conn, data["name"], placement_id)
    # Placement ID:tä ei muuteta: se on jo upotettu sivustoille (data-placement="...").
    row = update_row(conn, "placements", placement_id, data)
    if not row:
        raise HTTPException(404, "Mainospaikkaa ei löytynyt.")
    return row


@router.delete("/{placement_id}", status_code=204, dependencies=[Depends(require_admin)])
def delete_placement(placement_id: int, conn=Depends(get_conn)):
    """DELETE /api/placements/{placement_id} – poistaa mainospaikan (vain admin).

    Palauttaa 204. Virheet: 403 ei-admin, 404 ei löydy.
    Huom: kannan ON DELETE CASCADE poistaa samalla paikan kampanjaliitokset, sijoitukset
    sekä niiden näyttö- ja klikkitilastot. Käytöstä poistoon riittää status 'inactive'.
    """
    if not delete_row(conn, "placements", placement_id):
        raise HTTPException(404, "Mainospaikkaa ei löytynyt.")
