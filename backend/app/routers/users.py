"""Käyttäjähallinta – vain Admin (määrittely luku 14).

Endpointit (polun /api/users alla):
  GET    /api/users         -> kaikki käyttäjät (ilman salasanan hajautusarvoa)
  POST   /api/users         -> uusi käyttäjä
  PUT    /api/users/{id}    -> käyttäjän päivitys (salasana valinnainen)
  DELETE /api/users/{id}    -> käyttäjän poisto

Oikeudet: koko router vaatii admin-roolin (dependencies APIRouterissa), ja main.py
vaatii lisäksi kirjautumisen. Editor saa siis 403, kirjautumaton 401.

Roolit: 'admin' (kaikki oikeudet, myös käyttäjät) ja 'editor' (kampanjat ja mainokset).
Turvasäännöt: järjestelmään jää aina vähintään yksi aktiivinen admin, eikä admin voi
poistaa omaa tunnustaan. Frontendissä tätä käyttää users.html / js/users.js.
"""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import check_password_strength, hash_password, require_admin
from ..db import get_conn

router = APIRouter(prefix="/api/users", tags=["Käyttäjät"], dependencies=[Depends(require_admin)])

# Literal rajaa sallitut arvot: muu rooli -> 422 jo validoinnissa.
Role = Literal["admin", "editor"]
# Palautettavat sarakkeet. password_hash jätetään tarkoituksella pois, ettei se päädy
# koskaan selaimeen. Vakio on koodissa (ei käyttäjältä), joten f-stringiin liittäminen
# SQL:ään on turvallista.
FIELDS = "id, email, name, role, is_active, last_login_at, created_at"


class UserCreate(BaseModel):
    """Uuden käyttäjän runko. pattern on yksinkertainen sähköpostin muototarkistus."""
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    name: str = Field(min_length=1, max_length=100)
    role: Role = "editor"
    is_active: bool = True
    password: str = Field(min_length=1, max_length=200)


class UserUpdate(BaseModel):
    """Päivityksen runko. Kaikki kentät annetaan aina, paitsi salasana (tyhjä = ennallaan)."""
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    name: str = Field(min_length=1, max_length=100)
    role: Role
    is_active: bool
    password: str | None = Field(default=None, max_length=200, description="Tyhjä = ei muuteta")


def _other_active_admins(conn, user_id: int) -> int:
    """Montako aktiivista adminia on, kun käsiteltävä käyttäjä (user_id) jätetään pois.

    Jos 0, käyttäjän poisto tai alentaminen jättäisi järjestelmän ilman adminia.
    """
    return conn.execute(
        "SELECT count(*) AS n FROM users WHERE role = 'admin' AND is_active AND id <> %s", [user_id]
    ).fetchone()["n"]


@router.get("")
def list_users(conn=Depends(get_conn)):
    """GET /api/users – kaikki käyttäjät nimen mukaan järjestettynä (FIELDS-sarakkeet).

    Virheet: 401 ei kirjautunut, 403 ei admin.
    """
    return conn.execute(f"SELECT {FIELDS} FROM users ORDER BY name").fetchall()


@router.post("", status_code=201)
def create_user(body: UserCreate, conn=Depends(get_conn)):
    """POST /api/users – luo käyttäjän annetulla salasanalla.

    Palauttaa luodun käyttäjän (201). Virheet: 422 virheellinen runko tai liian lyhyt
    salasana, 409 sähköposti jo käytössä (UNIQUE-rajoite, ks. main.py).
    """
    check_password_strength(body.password)
    # Sähköposti tallennetaan pienillä kirjaimilla (lower), jotta kirjautuminen ja
    # yksilöllisyys eivät riipu kirjainkoosta. Salasanasta tallennetaan vain hajautus.
    # RETURNING palauttaa lisätyn rivin samalla kyselyllä.
    return conn.execute(
        f"""INSERT INTO users (email, name, role, is_active, password_hash)
            VALUES (lower(%s), %s, %s, %s, %s) RETURNING {FIELDS}""",
        [body.email.strip(), body.name, body.role, body.is_active, hash_password(body.password)],
    ).fetchone()


@router.put("/{user_id}")
def update_user(user_id: int, body: UserUpdate, me=Depends(require_admin), conn=Depends(get_conn)):
    """PUT /api/users/{user_id} – päivittää käyttäjän tiedot, roolin ja tilan.

    Salasana vaihdetaan vain, jos se on annettu. me = pyynnön tehnyt admin.
    Palauttaa päivitetyn käyttäjän. Virheet: 404 ei löydy, 409 viimeinen aktiivinen
    admin yritettiin alentaa/poistaa käytöstä tai sähköposti jo käytössä,
    422 virheellinen runko tai liian lyhyt salasana.
    """
    # Järjestelmään on aina jäätävä vähintään yksi aktiivinen admin.
    losing_admin = body.role != "admin" or not body.is_active
    if losing_admin and _other_active_admins(conn, user_id) == 0:
        raise HTTPException(409, "Järjestelmässä on oltava vähintään yksi aktiivinen admin.")

    # UPDATE-kysely kootaan kahdessa osassa: salasanan sarake lisätään vain tarvittaessa.
    # set_pw on koodin vakio, ja itse arvot kulkevat %s-parametreina.
    params = [body.email.strip(), body.name, body.role, body.is_active]
    set_pw = ""
    if body.password:
        check_password_strength(body.password)
        set_pw = ", password_hash = %s"
        params.append(hash_password(body.password))

    row = conn.execute(
        f"""UPDATE users SET email = lower(%s), name = %s, role = %s, is_active = %s{set_pw}
            WHERE id = %s RETURNING {FIELDS}""",
        [*params, user_id],
    ).fetchone()
    if not row:
        raise HTTPException(404, "Käyttäjää ei löytynyt.")
    # Poistettu käyttö tai vaihdettu salasana -> kirjataan käyttäjä ulos muualta.
    # Jos admin vaihtaa oman salasanansa tätä kautta, omia sessioita ei poisteta,
    # jottei admin kirjaudu ulos kesken työn.
    if not body.is_active or (body.password and user_id != me["id"]):
        conn.execute("DELETE FROM sessions WHERE user_id = %s", [user_id])
    return row


@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: int, me=Depends(require_admin), conn=Depends(get_conn)):
    """DELETE /api/users/{user_id} – poistaa käyttäjän pysyvästi.

    Palauttaa 204. Virheet: 409 oman tunnuksen poisto tai viimeinen aktiivinen admin,
    404 käyttäjää ei löydy. (Käyttäjän sessiot poistuvat kannan ON DELETE CASCADE
    -säännöllä.) Väliaikaiseen estoon kannattaa käyttää is_active=false.
    """
    if user_id == me["id"]:
        raise HTTPException(409, "Et voi poistaa omaa tunnustasi.")
    if _other_active_admins(conn, user_id) == 0:
        raise HTTPException(409, "Järjestelmässä on oltava vähintään yksi aktiivinen admin.")
    if conn.execute("DELETE FROM users WHERE id = %s", [user_id]).rowcount == 0:
        raise HTTPException(404, "Käyttäjää ei löytynyt.")
