"""Louhi Ads – backend.

Käynnistys (backend-kansiossa):  uvicorn app.main:app --reload
  - API-dokumentaatio:   http://localhost:8000/docs
  - Hallintapaneeli:     http://localhost:8000/dashboard.html

Tämä on sovelluksen kokoava tiedosto: täällä luodaan FastAPI-sovellus ja
kytketään siihen kaikki osat.
  - tietokantapoolin avaus ja sulkeminen (db.py)
  - middlewaret: CORS, kirjautumisvaatimus HTML-sivuille, välimuistiotsakkeet
  - tietokannan eheysvirheiden muunto suomenkielisiksi HTTP-virheiksi
  - API-reitit (routers/*.py) ja niiden suojaus kirjautumisella (auth.py)
  - mainoskuvien tarjoilu /media/-osoitteesta (media.py)
  - frontendin (HTML/CSS/JS) tarjoilu samasta palvelimesta

Middleware = funktio, jonka läpi JOKAINEN HTTP-pyyntö kulkee ennen reittiä
(ja vastaus takaisin sen jälkeen). Sopii asioihin, jotka koskevat kaikkia pyyntöjä.
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
from .routers import (advertisers, auth, campaigns, creatives, environments, placements, serving,
                      stats, users)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Sovelluksen elinkaari: yield-rivi jakaa käynnistyksen ja sammutuksen.

    Käynnistyksessä avataan tietokantapooli ja odotetaan (enint. 10 s), että
    yhteys toimii. Näin väärä DATABASE_URL huomataan heti eikä vasta ensimmäisessä
    pyynnössä. Sammuttaessa yhteydet suljetaan siististi.
    """
    pool.open(wait=True, timeout=10)
    yield
    pool.close()


app = FastAPI(title="Louhi Ads API", version="0.1.0", lifespan=lifespan)

# CORS: selain sallii toisesta osoitteesta (origin) tulevat API-kutsut vain, jos
# palvelin lupaa sen. Hallintapaneeli tarjoillaan samasta osoitteesta, joten sitä
# tämä ei koske; asetus on mainostagia ja erillistä kehityspalvelinta varten.
# CORS_ORIGINS on pilkuilla eroteltu lista, esim. "https://a.fi,https://b.fi".
# Huom: allow_credentials on pois päältä, joten muiden sivustojen JavaScript ei
# voi tehdä kirjautuneena (evästeellä) kutsuja ja lukea vastauksia, vaikka origin
# olisi "*". Mainostagin julkiset kutsut eivät evästettä tarvitse.
origins = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_methods=["*"],
    allow_headers=["*"],
)


# HTML-sivut, jotka näkyvät ilman kirjautumista
PUBLIC_PAGES = {"/login.html", "/ad-demo.html"}
# Kansiot, joiden kaikki sivut ovat julkisia. demopage/ on esimerkkiasiakkaan
# verkkosivu ja newsletter/ esimerkkiuutiskirje, joilla mainospaikkoja testataan,
# joten niiden pitää aueta kenelle tahansa.
PUBLIC_PREFIXES = ("/demopage/", "/newsletter/")


def _has_valid_session(token: str | None) -> bool:
    """True, jos evästeen sessiotunniste on voimassa ja käyttäjä aktiivinen.

    Tavallinen (synkroninen) funktio, koska psycopg-pooli on synkroninen;
    middleware kutsuu sitä run_in_threadpoolin kautta.
    """
    if not token:
        return False
    with pool.connection() as conn:
        return user_for_token(conn, token) is not None


@app.middleware("http")
async def require_login_for_pages(request: Request, call_next):
    """Kirjautumaton käyttäjä ohjataan hallintapaneelin sivuilta kirjautumissivulle.
    (API suojataan erikseen riippuvuuksilla, ks. include_router alla.)

    Vain HTML-sivut tarkistetaan: CSS/JS/kuvat saavat latautua myös
    kirjautumissivulle. Sivun suojaus on lähinnä käytettävyyttä (ei tyhjää
    paneelia); varsinainen tietoturva on API:n kirjautumisvaatimuksessa.
    """
    path = request.url.path
    is_page = path == "/" or path.endswith(".html")
    if is_page and path not in PUBLIC_PAGES and not path.startswith(PUBLIC_PREFIXES):
        token = request.cookies.get(SESSION_COOKIE)
        # Tietokantakysely on estävä (blocking), joten se ajetaan erillisessä
        # säikeessä. Muuten async-middleware jumittaisi kaikki muut pyynnöt.
        if not await run_in_threadpool(_has_valid_session, token):
            # ?next= kertoo kirjautumissivulle, minne palata kirjautumisen jälkeen.
            # 303 = "katso toinen osoite", selain tekee uuden GET-pyynnön.
            target = "/login.html" if path in ("/", "/index.html") else f"/login.html?next={path}"
            return RedirectResponse(target, status_code=303)
    return await call_next(request)


@app.middleware("http")
async def revalidate_static_files(request: Request, call_next):
    """Kehityksen aikana selain tarkistaa HTML/CSS/JS-tiedostot joka kerta
    (no-cache = käytä välimuistia vain, jos tiedosto ei ole muuttunut).

    Näin tiimin muutokset näkyvät heti ilman välimuistin tyhjennystä.
    """
    response = await call_next(request)
    # setdefault: ei ylikirjoiteta reitin omaa Cache-Control-otsaketta
    # (esim. /media/-kuvien pitkä välimuisti säilyy).
    if not request.url.path.startswith("/api/"):
        response.headers.setdefault("Cache-Control", "no-cache")
    return response


# ---------------------------------------------------------------------------
# Tietokannan rajoitusvirheet -> selkeät HTTP-virheet suomeksi
# ---------------------------------------------------------------------------
@app.exception_handler(pg_errors.IntegrityError)
def integrity_error(request: Request, exc: pg_errors.IntegrityError):
    """Muuntaa PostgreSQL:n eheysvirheet selkeiksi HTTP-vastauksiksi.

    Ilman tätä esim. päällekkäinen nimi aiheuttaisi HTTP 500 -virheen. Kanta
    valvoo ehdot (UNIQUE, FOREIGN KEY, CHECK), joten reittien ei tarvitse
    tarkistaa niitä erikseen. Vastauksen "constraint"-kenttä kertoo rikotun
    ehdon nimen (db/schema.sql), mikä helpottaa vianetsintää frontendissä.
    """
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
# kohtaisesti (users.py, sekä environments/placements/advertisers -kirjoitusoperaatiot).
# dependencies=[...] ajaa get_current_user-tarkistuksen ennen jokaista routerin
# reittiä; puuttuva tai vanhentunut sessio -> HTTP 401.
for r in (advertisers, environments, placements, campaigns, creatives, stats, users):
    app.include_router(r.router, dependencies=[Depends(get_current_user)])

# Julkiset: kirjautuminen sekä mainostagin kutsut (/api/v1/ad, /api/v1/click)
app.include_router(auth.router)
app.include_router(serving.router)


@app.get("/media/{name}", include_in_schema=False)
def media_file(name: str):
    """Ladatut mainoskuvat (tietokannasta). Julkinen, koska mainostagi näyttää kuvat
    muilla sivustoilla. Nimi on satunnainen eikä sisältö muutu -> pitkä välimuisti.

    include_in_schema=False piilottaa reitin /docs-sivulta (ei osa hallinta-API:a).
    get_image tarkistaa nimen, joten polkuja (../) ei voi käyttää.
    """
    with pool.connection() as conn:
        found = get_image(conn, name)
    if not found:
        raise HTTPException(status_code=404)
    data, content_type = found
    return Response(data, media_type=content_type,
                    headers={"Cache-Control": "public, max-age=31536000, immutable"})


@app.get("/api/health", tags=["Järjestelmä"])
def health():
    """Terveystarkistus: vastaa "ok", jos palvelin ja tietokanta toimivat.

    Hostingpalvelu (Render) ja seuranta voivat kutsua tätä ilman kirjautumista.
    """
    with pool.connection() as conn:
        conn.execute("SELECT 1")
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Hallintapaneelin HTML-sivut tarjoillaan samasta palvelimesta, jolloin
# selain ja API ovat samassa osoitteessa (ei CORS-ongelmia).
# backend/ ja db/ -kansiot sekä pisteellä alkavat tiedostot (.env, .git)
# on estetty, jottei esim. tietokannan salasana vuoda selaimeen.
# ---------------------------------------------------------------------------
# Oletuksena projektin juurikansio (app/ -> backend/ -> juuri), jossa HTML-sivut ovat.
FRONTEND_DIR = Path(os.getenv("FRONTEND_DIR", Path(__file__).resolve().parents[2]))
BLOCKED_DIRS = {"backend", "db"}


class SafeStaticFiles(StaticFiles):
    """FastAPIn StaticFiles, joka kieltäytyy tarjoilemasta arkaluontoisia tiedostoja.

    Frontend on samassa kansiossa kuin backend/ ja db/, joten ilman tätä
    esim. /backend/.env olisi ladattavissa selaimella. Estetyt polut saavat
    404:n (ei 403), jottei edes niiden olemassaoloa paljasteta.
    """

    async def get_response(self, path: str, scope):
        """Tarkistaa polun osat ennen kuin tiedosto haetaan levyltä."""
        # lower(): estää kiertämisen kirjainkoolla (esim. /Backend/) kirjainkoosta
        # riippumattomilla tiedostojärjestelmillä (Windows, macOS).
        parts = [p.lower() for p in Path(path).parts]
        if parts and (parts[0] in BLOCKED_DIRS or any(p.startswith(".") for p in parts)):
            raise HTTPException(status_code=404)
        return await super().get_response(path, scope)


# Liitetään viimeisenä: "/" kattaa kaikki polut, joten aiemmin määritellyt
# reitit (/api/..., /media/...) tarkistetaan ensin. html=True tarjoilee
# kansion index.html-tiedoston, kun osoitteena on pelkkä kansio.
app.mount("/", SafeStaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
