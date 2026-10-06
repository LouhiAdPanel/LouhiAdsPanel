"""Louhi Ads – backend.

Käynnistys (backend-kansiossa):  uvicorn app.main:app --reload
  - API-dokumentaatio:   http://localhost:8000/docs
  - Hallintapaneeli:     http://localhost:8000/dashboard.html
"""
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import Depends, FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse, Response
from fastapi.staticfiles import StaticFiles
from psycopg import errors as pg_errors

from .auth import SESSION_COOKIE, get_current_user, user_for_token
from .db import pool
from .media import get_image
from .routers import advertisers, auth, campaigns, creatives, placements, serving, stats, users


@asynccontextmanager
async def lifespan(app: FastAPI):
    pool.open(wait=True, timeout=10)
    yield
    pool.close()


app = FastAPI(title="Louhi Ads API", version="0.1.0", lifespan=lifespan)

origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# HTML-sivut, jotka näkyvät ilman kirjautumista
PUBLIC_PAGES = {"/login.html", "/ad-demo.html"}


def _has_valid_session(token: str | None) -> bool:
    if not token:
        return False
    with pool.connection() as conn:
        return user_for_token(conn, token) is not None


@app.middleware("http")
async def require_login_for_pages(request: Request, call_next):
    """Kirjautumaton käyttäjä ohjataan hallintapaneelin sivuilta kirjautumissivulle.
    (API suojataan erikseen riippuvuuksilla, ks. include_router alla.)"""
    path = request.url.path
    is_page = path == "/" or path.endswith(".html")
    if is_page and path not in PUBLIC_PAGES:
        token = request.cookies.get(SESSION_COOKIE)
        if not await run_in_threadpool(_has_valid_session, token):
            target = "/login.html" if path in ("/", "/index.html") else f"/login.html?next={path}"
            return RedirectResponse(target, status_code=303)
    return await call_next(request)


@app.middleware("http")
async def revalidate_static_files(request: Request, call_next):
    """Kehityksen aikana selain tarkistaa HTML/CSS/JS-tiedostot joka kerta
    (no-cache = käytä välimuistia vain, jos tiedosto ei ole muuttunut)."""
    response = await call_next(request)
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


# ---------------------------------------------------------------------------
# Tietokannan rajoitusvirheet -> selkeät HTTP-virheet suomeksi
# ---------------------------------------------------------------------------
@app.exception_handler(pg_errors.IntegrityError)
def integrity_error(request: Request, exc: pg_errors.IntegrityError):
    if isinstance(exc, pg_errors.UniqueViolation):
        msg, code = "Arvo on jo käytössä (esim. sama nimi tai placement ID).", 409
    elif isinstance(exc, pg_errors.ForeignKeyViolation):
        msg, code = ("Viitattua riviä ei ole olemassa, tai riviin viitataan muualta "
                     "eikä sitä siksi voi poistaa."), 409
    elif isinstance(exc, pg_errors.CheckViolation):
        msg, code = "Arvo ei täytä tietokannan ehtoja.", 422
    else:
        msg, code = "Tietokannan eheysvirhe.", 409
    detail = exc.diag.constraint_name or exc.diag.message_primary
    return JSONResponse({"detail": msg, "constraint": detail}, status_code=code)


# Hallinta-API vaatii kirjautumisen. Admin-oikeudet tarkistetaan reitti-
# kohtaisesti (users.py, sekä placements/advertisers -kirjoitusoperaatiot).
for r in (advertisers, placements, campaigns, creatives, stats, users):
    app.include_router(r.router, dependencies=[Depends(get_current_user)])

# Julkiset: kirjautuminen sekä mainostagin kutsut (/api/v1/ad, /api/v1/click)
app.include_router(auth.router)
app.include_router(serving.router)


@app.get("/media/{name}", include_in_schema=False)
def media_file(name: str):
    """Ladatut mainoskuvat (tietokannasta). Julkinen, koska mainostagi näyttää kuvat
    muilla sivustoilla. Nimi on satunnainen eikä sisältö muutu -> pitkä välimuisti."""
    with pool.connection() as conn:
        found = get_image(conn, name)
    if not found:
        raise HTTPException(status_code=404)
    data, content_type = found
    return Response(data, media_type=content_type,
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/health", tags=["Järjestelmä"])
def health():
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Hallintapaneelin HTML-sivut tarjoillaan samasta palvelimesta, jolloin
# selain ja API ovat samassa osoitteessa (ei CORS-ongelmia).
# backend/ ja db/ -kansiot sekä pisteellä alkavat tiedostot (.env, .git)
# on estetty, jottei esim. tietokannan salasana vuoda selaimeen.
# ---------------------------------------------------------------------------
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", Path(__file__).resolve().parents[2]))
BLOCKED_DIRS = {"backend", "db"}


class SafeStaticFiles(StaticFiles):
    async def get_response(self, path: str, scope):
        parts = [p.lower() for p in Path(path).parts]
        if parts and (parts[0] in BLOCKED_DIRS or any(p.startswith(".") for p in parts)):
            raise HTTPException(status_code=404)
        return await super().get_response(path, scope)


app.mount("/", SafeStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
