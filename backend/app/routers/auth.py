"""Kirjautuminen ja oma tili (määrittely luku 14).

Endpointit (polun /api/auth alla):
  POST /api/auth/login      -> kirjautuminen, asettaa sessioevästeen       (julkinen)
  POST /api/auth/logout     -> uloskirjautuminen, poistaa session          (julkinen)
  GET  /api/auth/me         -> kirjautuneen käyttäjän tiedot               (kirjautunut)
  PUT  /api/auth/password   -> oman salasanan vaihto                       (kirjautunut)

Oikeudet: main.py liittää tämän routerin ILMAN kirjautumisvaatimusta (muuten
kirjautuminen olisi mahdotonta). /me ja /password vaativat kirjautumisen omalla
get_current_user-riippuvuudellaan.

Liittyy: varsinainen logiikka (salasanojen hajautus, sessiot, eväste, yritysten
rajoitus) on tiedostossa app/auth.py; tämä tiedosto vain kytkee sen HTTP-reitteihin.
Frontendissä js/login.js ja js/auth.js kutsuvat näitä reittejä.
"""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..auth import (
    _DUMMY_HASH, MIN_PASSWORD_LENGTH, SESSION_COOKIE, _token_hash, check_password_strength, check_rate_limit, clear_failures,
    clear_session_cookie, create_session, delete_session, get_current_user, hash_password,
    record_failure, set_session_cookie, verify_password,
)
from ..db import get_conn

router = APIRouter(prefix="/api/auth", tags=["Kirjautuminen"])


# Pydantic-mallit kuvaavat pyynnön JSON-rungon. FastAPI validoi rungon niitä vasten
# ja palauttaa automaattisesti 422, jos kenttä puuttuu tai on väärän pituinen.
class LoginIn(BaseModel):
    """Kirjautumislomakkeen runko."""
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class PasswordChangeIn(BaseModel):
    """Salasanan vaihdon runko. Vahvuus tarkistetaan erikseen (check_password_strength)."""
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=1, max_length=200)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, conn=Depends(get_conn)):
    """POST /api/auth/login – kirjautuminen sähköpostilla ja salasanalla (julkinen).

    Onnistuessa luo session tietokantaan, asettaa HttpOnly-sessioevästeen ja palauttaa
    käyttäjän perustiedot {id, email, name, role}. Selain lähettää evästeen jatkossa
    automaattisesti, joten frontend ei käsittele tokenia itse.
    Virheet: 401 väärä tunnus/salasana tai käyttäjä ei aktiivinen (sama viesti kaikissa,
    jottei paljasteta, onko tunnus olemassa), 429 liian monta epäonnistunutta yritystä.
    """
    email = body.email.strip().lower()
    client = request.client.host if request.client else "?"
    # Epäonnistuneet yritykset lasketaan sähköposti+IP-parille (muistissa, app/auth.py).
    # 5 virhettä 15 minuutissa -> 429. Hidastaa salasanojen arvailua.
    limit_key = f"{email}|{client}"
    check_rate_limit(limit_key)

    # Haetaan käyttäjä sähköpostilla kirjainkoosta riippumatta (lower(email)).
    user = conn.execute(
        "SELECT id, email, name, role, password_hash, is_active FROM users WHERE lower(email) = %s",
        [email],
    ).fetchone()

    # Tarkistetaan aina jotain hashia vastaan, jottei vastausaika paljasta tunnuksen olemassaoloa.
    valid = verify_password(body.password, user["password_hash"] if user else _DUMMY_HASH)
    if not (user and valid and user["is_active"]):
        record_failure(limit_key)
        raise HTTPException(401, "Väärä sähköposti tai salasana.")

    clear_failures(limit_key)
    # create_session tallentaa kantaan vain tokenin hajautusarvon; selain saa itse tokenin.
    token = create_session(conn, user["id"])
    set_session_cookie(response, token)
    return {"id": user["id"], "email": user["email"], "name": user["name"], "role": user["role"]}


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, conn=Depends(get_conn)):
    """POST /api/auth/logout – uloskirjautuminen (julkinen, ei virhettä ilman sessiota).

    Poistaa nykyisen session tietokannasta ja tyhjentää evästeen. Palauttaa 204.
    """
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        delete_session(conn, token)
    clear_session_cookie(response)


@router.get("/me")
def me(user=Depends(get_current_user)):
    """GET /api/auth/me – kirjautuneen käyttäjän tiedot (kirjautunut).

    Palauttaa {id, email, name, role, min_password_length}. Frontend käyttää tätä
    mm. näyttämään käyttäjän nimen ja piilottamaan admin-toiminnot editoreilta.
    Salasanan minimipituus kerrotaan, jotta lomake voi ohjeistaa käyttäjää.
    Virheet: 401, jos sessiota ei ole tai se on vanhentunut.
    """
    return {**user, "min_password_length": MIN_PASSWORD_LENGTH}


@router.put("/password", status_code=204)
def change_password(body: PasswordChangeIn, request: Request,
                    user=Depends(get_current_user), conn=Depends(get_conn)):
    """PUT /api/auth/password – oman salasanan vaihto (kirjautunut).

    Vaatii nykyisen salasanan. Palauttaa 204. Muut sessiot kirjataan ulos.
    Virheet: 400 nykyinen salasana väärin, 422 uusi salasana liian lyhyt
    (check_password_strength) tai virheellinen runko, 401 ei kirjautunut.
    """
    row = conn.execute("SELECT password_hash FROM users WHERE id = %s", [user["id"]]).fetchone()
    if not verify_password(body.current_password, row["password_hash"]):
        raise HTTPException(400, "Nykyinen salasana on väärin.")
    check_password_strength(body.new_password)
    conn.execute("UPDATE users SET password_hash = %s WHERE id = %s",
                 [hash_password(body.new_password), user["id"]])
    # Kirjataan ulos muut sessiot (esim. toinen selain), nykyinen jää voimaan.
    # Kannassa on tokenien hajautusarvot, joten nykyinen token hajautetaan vertailua varten.
    conn.execute(
        "DELETE FROM sessions WHERE user_id = %s AND token_hash <> %s",
        [user["id"], _token_hash(request.cookies.get(SESSION_COOKIE, ""))],
    )
