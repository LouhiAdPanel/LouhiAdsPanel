"""Ympäristöt (environments) – Ympäristöt-sivu (environments.html, vain admin).

Ympäristö = palvelu tai kanava, jossa mainospaikat ovat (esim. Louhi Konsoli, www,
Uutiskirje). Mainospaikan lomake valitsee ympäristön tästä listasta.
channel: 'web' = verkkosivu (mainostagi louhi-ads.js), 'email' = sähköposti/uutiskirje
(kuva + linkki -upotus, ks. serving.py). Mainospaikat-sivun upotuskoodi valitaan tämän mukaan.

Endpointit (polun /api/environments alla):
  GET    /api/environments        -> kaikki ympäristöt + mainospaikkojen määrä   (kaikki)
  POST   /api/environments        -> uusi ympäristö                               (vain admin)
  PUT    /api/environments/{id}   -> päivitys                                     (vain admin)
  DELETE /api/environments/{id}   -> poisto, jos ympäristössä ei ole paikkoja     (vain admin)

Oikeudet: lukeminen kaikille kirjautuneille (mainospaikkalomake ja -lista tarvitsevat
listan), kirjoittaminen vain adminille.

Tietokanta: placements.environment viittaa ympäristön nimeen (migraatio 009):
nimen muutos päivittyy automaattisesti mainospaikoille (ON UPDATE CASCADE), ja
käytössä olevan ympäristön poisto estetään (ON DELETE RESTRICT).
"""
from fastapi import APIRouter, Depends, HTTPException

from ..auth import require_admin
from ..db import get_conn, insert_row, update_row
from ..schemas import EnvironmentIn
from .placements import normalize_name

router = APIRouter(prefix="/api/environments", tags=["Ympäristöt"])

LIST_SQL = """
SELECT e.*, count(p.id) AS placement_count
FROM environments e
LEFT JOIN placements p ON p.environment = e.name
{where}
GROUP BY e.id
ORDER BY e.name
"""

# Sama nimisääntö kuin mainospaikoilla: kirjainkoko ja ylimääräiset välilyönnit eivät
# tee nimestä eri nimeä ("www" ja "WWW" ovat sama).
SAME_NAME_SQL = """
SELECT name FROM environments
WHERE lower(regexp_replace(btrim(name), '\\s+', ' ', 'g')) = lower(%s) AND id <> %s
LIMIT 1
"""


def _check_unique_name(conn, name: str, exclude_id: int = -1) -> None:
    row = conn.execute(SAME_NAME_SQL, [name, exclude_id]).fetchone()
    if row:
        raise HTTPException(409, f"Ympäristö nimellä \"{row['name']}\" on jo olemassa.")


def _get(conn, env_id: int) -> dict:
    row = conn.execute(LIST_SQL.format(where="WHERE e.id = %s"), [env_id]).fetchone()
    if not row:
        raise HTTPException(404, "Ympäristöä ei löytynyt.")
    return row


@router.get("")
def list_environments(conn=Depends(get_conn)):
    """GET /api/environments – ympäristöt nimen mukaan, mukana placement_count."""
    return conn.execute(LIST_SQL.format(where="")).fetchall()


@router.post("", status_code=201, dependencies=[Depends(require_admin)])
def create_environment(body: EnvironmentIn, conn=Depends(get_conn)):
    """POST /api/environments – luo ympäristön (vain admin).
    Virheet: 403 ei-admin, 409 nimi jo käytössä, 422 virheellinen runko."""
    data = body.model_dump()
    data["name"] = normalize_name(data["name"])
    _check_unique_name(conn, data["name"])
    row = insert_row(conn, "environments", data)
    return _get(conn, row["id"])


@router.put("/{env_id}", dependencies=[Depends(require_admin)])
def update_environment(env_id: int, body: EnvironmentIn, conn=Depends(get_conn)):
    """PUT /api/environments/{id} – päivittää nimen, kanavan ja kuvauksen (vain admin).
    Nimen muutos päivittyy ympäristön mainospaikoille (ON UPDATE CASCADE).
    Virheet: 403, 404 ei löydy, 409 nimi jo toisella ympäristöllä."""
    data = body.model_dump()
    data["name"] = normalize_name(data["name"])
    _check_unique_name(conn, data["name"], env_id)
    if not update_row(conn, "environments", env_id, data):
        raise HTTPException(404, "Ympäristöä ei löytynyt.")
    return _get(conn, env_id)


@router.delete("/{env_id}", status_code=204, dependencies=[Depends(require_admin)])
def delete_environment(env_id: int, conn=Depends(get_conn)):
    """DELETE /api/environments/{id} – poistaa ympäristön (vain admin).
    Ympäristöä, jossa on mainospaikkoja, ei voi poistaa (409): siirrä tai poista
    paikat ensin. Virheet: 403, 404 ei löydy, 409 käytössä."""
    env = _get(conn, env_id)
    if env["placement_count"]:
        raise HTTPException(
            409, f"Ympäristössä \"{env['name']}\" on {env['placement_count']} mainospaikkaa. "
                 "Siirrä mainospaikat toiseen ympäristöön tai poista ne ennen ympäristön poistoa.")
    conn.execute("DELETE FROM environments WHERE id = %s", [env_id])
