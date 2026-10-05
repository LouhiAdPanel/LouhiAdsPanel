"""Kirjautuminen: salasanojen tiivisteet, sessiot ja oikeustarkistukset.

- Salasanat: scrypt (Pythonin vakiokirjasto, ei lisäriippuvuuksia).
- Sessio: satunnainen tunniste HttpOnly-evästeessä. Tietokantaan tallennetaan
  vain tunnisteen SHA-256-tiiviste, joten vuotanut tietokanta ei paljasta sessioita.
- Roolit (määrittely luku 14):
    admin  – kaikki, myös käyttäjät, mainostajat ja mainospaikat
    editor – kampanjat, mainokset ja raportit
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
SESSION_HOURS = int(os.getenv("SESSION_HOURS", "8"))
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"  # true kun HTTPS

# ---------------------------------------------------------------------------
# Salasanat
# ---------------------------------------------------------------------------
_N, _R, _P, _DKLEN = 2**14, 8, 1, 64


def _b64(b: bytes) -> str:
    return base64.b64encode(b).decode()


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode(), salt=salt, n=_N, r=_R, p=_P, dklen=_DKLEN)
    return f"scrypt${_N}${_R}${_P}${_b64(salt)}${_b64(digest)}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algo, n, r, p, salt, digest = stored.split("$")
        if algo != "scrypt":
            return False
        expected = base64.b64decode(digest)
        actual = hashlib.scrypt(password.encode(), salt=base64.b64decode(salt),
                                n=int(n), r=int(r), p=int(p), dklen=len(expected))
        return hmac.compare_digest(actual, expected)
    except (ValueError, TypeError):
        return False  # esim. '!' = salasanaa ei ole asetettu


# Käytetään, kun käyttäjää ei löydy, jotta vastausaika ei paljasta olemassa olevia tunnuksia.
_DUMMY_HASH = hash_password(secrets.token_hex(8))


# Salasanan vähimmäispituus. Muutettavissa .env-tiedostossa: MIN_PASSWORD_LENGTH=8
MIN_PASSWORD_LENGTH = int(os.getenv("MIN_PASSWORD_LENGTH", "6"))


def check_password_strength(password: str) -> None:
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(422, f"Salasanan on oltava vähintään {MIN_PASSWORD_LENGTH} merkkiä pitkä.")


# ---------------------------------------------------------------------------
# Kirjautumisyritysten rajoitus (yksinkertainen, palvelimen muistissa)
# ---------------------------------------------------------------------------
MAX_FAILURES, WINDOW_SECONDS = 5, 15 * 60
_failures: dict[str, list[float]] = defaultdict(list)


def check_rate_limit(key: str) -> None:
    now = time.monotonic()
    _failures[key] = [t for t in _failures[key] if now - t < WINDOW_SECONDS]
    if len(_failures[key]) >= MAX_FAILURES:
        raise HTTPException(429, "Liian monta epäonnistunutta yritystä. Odota 15 minuuttia.")


def record_failure(key: str) -> None:
    _failures[key].append(time.monotonic())


def clear_failures(key: str) -> None:
    _failures.pop(key, None)


# ---------------------------------------------------------------------------
# Sessiot
# ---------------------------------------------------------------------------
def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def create_session(conn, user_id: int) -> str:
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
    conn.execute("DELETE FROM sessions WHERE token_hash = %s", [_token_hash(token)])


def user_for_token(conn, token: str | None) -> dict | None:
    if not token:
        return None
    return conn.execute(
        """SELECT u.id, u.email, u.name, u.role
           FROM sessions s JOIN users u ON u.id = s.user_id
           WHERE s.token_hash = %s AND s.expires_at > now() AND u.is_active""",
        [_token_hash(token)],
    ).fetchone()


def set_session_cookie(response, token: str) -> None:
    response.set_cookie(
        SESSION_COOKIE, token,
        max_age=SESSION_HOURS * 3600,
        httponly=True,          # JavaScript ei näe evästettä (XSS-suoja)
        samesite="lax",         # ei lähetetä muilta sivustoilta tehtyihin POST-pyyntöihin
        secure=COOKIE_SECURE,
        path="/",
    )


def clear_session_cookie(response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")


# ---------------------------------------------------------------------------
# FastAPI-riippuvuudet
# ---------------------------------------------------------------------------
def get_current_user(request: Request, conn=Depends(get_conn)) -> dict:
    user = user_for_token(conn, request.cookies.get(SESSION_COOKIE))
    if not user:
        raise HTTPException(401, "Kirjaudu sisään.")
    return user


def require_admin(user: dict = Depends(get_current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(403, "Toiminto vaatii Admin-oikeudet.")
    return user
