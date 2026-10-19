"""Kirjautuminen: salasanojen tiivisteet, sessiot ja oikeustarkistukset.

- Salasanat: scrypt (Pythonin vakiokirjasto, ei lisäriippuvuuksia).
- Sessio: satunnainen tunniste HttpOnly-evästeessä. Tietokantaan tallennetaan
  vain tunnisteen SHA-256-tiiviste, joten vuotanut tietokanta ei paljasta sessioita.
- Roolit (määrittely luku 14):
    admin  – kaikki, myös käyttäjät, mainostajat ja mainospaikat
    editor – kampanjat, mainokset ja raportit

Liittymät: routers/auth.py (kirjautuminen/uloskirjautuminen) käyttää
salasana-, rate limit- ja sessiofunktioita. main.py suojaa API:n
get_current_user-riippuvuudella ja HTML-sivut user_for_token-funktiolla.
Admin-reitit käyttävät require_admin-riippuvuutta. create_admin.py käyttää
hash_password-funktiota.
"""
import base64
import hashlib
import hmac
import os
import secrets
import time
from collections import defaultdict

from fastapi import Depends, HTTPException, Request

from .db import get_conn

SESSION_COOKIE = "louhi_session"
# Sessio vanhenee kiinteästi tämän ajan päästä kirjautumisesta (oletus 8 h = työpäivä).
SESSION_HOURS = int(os.getenv("SESSION_HOURS", "8"))
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"  # true kun HTTPS

# ---------------------------------------------------------------------------
# Salasanat
# ---------------------------------------------------------------------------
# scrypt-parametrit: N = laskennan työmäärä, r = lohkokoko, p = rinnakkaisuus,
# DKLEN = tiivisteen pituus tavuina. scrypt on tarkoituksella hidas ja vaatii
# paljon muistia, joten vuotaneiden tiivisteiden murtaminen arvaamalla on kallista
# (toisin kuin nopealla SHA-256:lla). Arvot tallennetaan tiivisteen mukaan, joten
# niitä voi myöhemmin kasvattaa ilman, että vanhat salasanat lakkaavat toimimasta.
_N, _R, _P, _DKLEN = 2**14, 8, 1, 64


def _b64(b: bytes) -> str:
    """Tavut base64-tekstiksi, jotta ne voi tallentaa tekstisarakkeeseen."""
    return base64.b64encode(b).decode()


def hash_password(password: str) -> str:
    """Laskee salasanasta tallennettavan tiivisteen.

    Muoto: ``scrypt$N$r$p$suola$tiiviste`` (users.password_hash). Jokaiselle
    salasanalle arvotaan oma satunnainen suola, joten samat salasanat tuottavat
    eri tiivisteet eikä valmiita tiivistetaulukoita voi käyttää.
    """
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return f"scrypt${_N}${_R}${_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    """Tarkistaa, vastaako annettu salasana tallennettua tiivistettä.

    Laskee tiivisteen uudelleen tallennetulla suolalla ja parametreilla ja
    vertaa tuloksia. Virheellinen tai tyhjä tallennettu arvo -> False.
    """
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt),
                                n=int(n), r=int(r), p=int(p), dklen=len(expected))
        # compare_digest vie aina yhtä kauan, toisin kuin ==, joka lopettaa
        # ensimmäiseen eroon. Näin vastausaika ei vihjaa oikeista tavuista.
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False  # esim. '!' = salasanaa ei ole asetettu


# Käytetään, kun käyttäjää ei löydy, jotta vastausaika ei paljasta olemassa olevia tunnuksia.
# (scrypt-tarkistus vie aikaa; ilman tätä tuntematon sähköposti vastaisi selvästi nopeammin.)
_DUMMY_HASH = hash_password(secrets.token_hex(8))


# Salasanan vähimmäispituus. Muutettavissa .env-tiedostossa: MIN_PASSWORD_LENGTH=8
MIN_PASSWORD_LENGTH = int(os.getenv("MIN_PASSWORD_LENGTH", "6"))


def check_password_strength(password: str) -> None:
    """Heittää HTTP 422 -virheen, jos salasana on liian lyhyt (uusi tai vaihdettu salasana)."""
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(422, f"Salasanan on oltava vähintään {MIN_PASSWORD_LENGTH} merkkiä pitkä.")


# ---------------------------------------------------------------------------
# Kirjautumisyritysten rajoitus (yksinkertainen, palvelimen muistissa)
# ---------------------------------------------------------------------------
# Estää salasanojen arvaamisen raa'alla voimalla: enintään 5 epäonnistunutta
# yritystä 15 minuutin liukuvassa ikkunassa. Avain (key) muodostetaan kutsujassa
# (routers/auth.py) muodossa "sähköposti|IP-osoite".
# Rajoitukset: tiedot ovat yhden palvelinprosessin muistissa, joten ne nollautuvat
# uudelleenkäynnistyksessä eivätkä jakaudu usean prosessin kesken. MVP:lle riittävä.
MAX_FAILURES, WINDOW_SECONDS = 5, 15 * 60
# avain -> epäonnistuneiden yritysten aikaleimat
_failures: dict[str, list[float]] = defaultdict(list)


def check_rate_limit(key: str) -> None:
    """Heittää HTTP 429 -virheen, jos avaimella on liikaa tuoreita epäonnistumisia.

    Kutsutaan ennen salasanan tarkistusta. Vanhentuneet aikaleimat siivotaan samalla.
    """
    # monotonic() ei hyppää kellonajan muutoksissa (esim. kesäaika), toisin kuin time().
    now = time.monotonic()
    _failures[key] = [t for t in _failures[key] if now - t < WINDOW_SECONDS]
    if len(_failures[key]) >= MAX_FAILURES:
        raise HTTPException(429, "Liian monta epäonnistunutta yritystä. Odota 15 minuuttia.")


def record_failure(key: str) -> None:
    """Kirjaa epäonnistuneen kirjautumisyrityksen."""
    _failures[key].append(time.monotonic())


def clear_failures(key: str) -> None:
    """Nollaa laskurin onnistuneen kirjautumisen jälkeen."""
    _failures.pop(key, None)


# ---------------------------------------------------------------------------
# Sessiot
# ---------------------------------------------------------------------------
def _token_hash(token: str) -> str:
    """Sessiotunnisteen SHA-256-tiiviste, joka tallennetaan kantaan tunnisteen sijaan.

    Nopea SHA-256 riittää tässä (toisin kuin salasanoille), koska tunniste on
    pitkä satunnainen merkkijono, jota ei voi arvata.
    """
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(conn, user_id: int) -> str:
    """Luo uuden session ja palauttaa tunnisteen, joka asetetaan evästeeseen.

    Tunniste palautetaan selaimelle vain tämän kerran; kantaan jää pelkkä
    tiiviste. Samalla poistetaan vanhentuneet sessiot ja päivitetään
    käyttäjän viimeisin kirjautumisaika.
    """
    # 32 satunnaista tavua kryptografisesta lähteestä (secrets, ei random).
    token = secrets.token_urlsafe(32)
    conn.execute("DELETE FROM sessions WHERE expires_at < now()")  # siivous
    conn.execute(
        """INSERT INTO sessions (token_hash, user_id, expires_at)
           VALUES (%s, %s, now() + make_interval(hours => %s))""",
        [_token_hash(token), user_id, SESSION_HOURS],
    )
    conn.execute("UPDATE users SET last_login_at = now() WHERE id = %s", [user_id])
    return token


def delete_session(conn, token: str) -> None:
    """Uloskirjautuminen: poistaa session kannasta, jolloin tunniste lakkaa toimimasta heti."""
    conn.execute("DELETE FROM sessions WHERE token_hash = %s", [_token_hash(token)])


def user_for_token(conn, token: str | None) -> dict | None:
    """Palauttaa session käyttäjän (id, email, name, role) tai None.

    None, jos tunniste puuttuu, on tuntematon, vanhentunut tai käyttäjä on
    poistettu käytöstä (is_active = false). Salasanan tiivistettä ei haeta.
    """
    if not token:
        return None
    return conn.execute(
        """SELECT u.id, u.email, u.name, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = %s AND s.expires_at > now() AND u.is_active""",
        [_token_hash(token)],
    ).fetchone()


def set_session_cookie(response, token: str) -> None:
    """Asettaa sessiotunnisteen evästeeseen kirjautumisvastauksessa.

    Selain lähettää evästeen automaattisesti jokaisessa saman palvelimen
    pyynnössä, joten frontendin ei tarvitse käsitellä tunnistetta itse.
    """
    response.set_cookie(
        SESSION_COOKIE, token,
        max_age=SESSION_HOURS * 3600,  # sama elinaika kuin sessiolla kannassa
        httponly=True,          # JavaScript ei näe evästettä (XSS-suoja)
        samesite="lax",         # ei lähetetä muilta sivustoilta tehtyihin POST-pyyntöihin
        secure=COOKIE_SECURE,   # True: eväste kulkee vain HTTPS:llä (tuotanto)
        path="/",               # koskee koko sivustoa: sekä HTML-sivuja että /api/
    )


def clear_session_cookie(response) -> None:
    """Poistaa sessioevästeen selaimesta (uloskirjautuminen). path oltava sama kuin asettaessa."""
    response.delete_cookie(SESSION_COOKIE, path="/")


# ---------------------------------------------------------------------------
# FastAPI-riippuvuudet
# Riippuvuus (Depends) on funktio, jonka FastAPI ajaa ennen reittiä. Jos se
# heittää HTTPExceptionin, reittiä ei ajeta lainkaan. Palautusarvon reitti saa
# parametrina, esim. ``user: dict = Depends(get_current_user)``.
# ---------------------------------------------------------------------------
def get_current_user(request: Request, conn=Depends(get_conn)) -> dict:
    """Palauttaa kirjautuneen käyttäjän evästeen perusteella, muuten HTTP 401."""
    user = user_for_token(conn, request.cookies.get(SESSION_COOKIE))
    if not user:
        raise HTTPException(401, "Kirjaudu sisään.")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    """Kuten get_current_user, mutta vaatii lisäksi admin-roolin (muuten HTTP 403).

    401 = ei kirjautunut, 403 = kirjautunut, mutta ei oikeuksia.
    """
    if user["role"] != "admin":
        raise HTTPException(403, "Toiminto vaatii Admin-oikeudet.")
    return user
