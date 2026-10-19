"""Tietokantayhteys: yhteyspooli ja apufunktiot yksinkertaisiin CRUD-kyselyihin.

Käytetään psycopg3-kirjastoa (PostgreSQL-ajuri). Yhteydet otetaan poolista eli
valmiiksi avattujen yhteyksien varastosta, koska uuden yhteyden avaaminen joka
pyynnölle olisi hidasta.

Liittymät muihin osiin:
- main.py avaa ja sulkee poolin (lifespan) ja käyttää sitä suoraan middlewareissa.
- routers/*.py saavat yhteyden riippuvuutena: ``conn=Depends(get_conn)``.
- insert_row/update_row/get_row/delete_row ovat routerien yhteisiä CRUD-apureita.

Rivit palautetaan sanakirjoina (dict_row), esim. ``row["name"]``, jolloin ne
voi palauttaa FastAPIsta suoraan JSONina.
"""
import os

from dotenv import load_dotenv
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

# Lukee backend/.env-tiedoston ympäristömuuttujiksi (paikallinen kehitys).
# Pilvessä (Render) muuttujat asetetaan palvelun asetuksista, eikä .env-tiedostoa ole.
load_dotenv()

# Oletusarvo sopii paikalliseen PostgreSQL-asennukseen; tuotannossa aina .env/ympäristö.
DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/louhiads"
)

# Koko sovelluksen yhteinen yhteyspooli. Enintään 10 samanaikaista yhteyttä;
# jos kaikki ovat käytössä, seuraava pyyntö odottaa vapautuvaa yhteyttä.
pool = ConnectionPool(
    DATABASE_URL,
    min_size=1,
    max_size=10,
    kwargs={"row_factory": dict_row},  # rivit dict-muodossa tuplen sijaan
    # Tarkistetaan yhteys ennen käyttöä: pilvitietokanta (esim. Neon) sulkee
    # käyttämättömät yhteydet, jolloin pooliin jäänyt yhteys voi olla katkennut.
    check=ConnectionPool.check_connection,
    open=False,  # avataan main.py:n lifespanissa
)


def get_conn():
    """FastAPI-riippuvuus: antaa yhteyden poolista.
    Onnistunut pyyntö commitoidaan, virhe perutaan (rollback).

    Käyttö reitissä: ``def reitti(conn=Depends(get_conn))``. Koska funktio on
    generaattori (yield), FastAPI ajaa yield-rivin jälkeisen osan vasta kun
    vastaus on valmis: silloin ``with``-lohko päättyy, transaktio commitoidaan
    (tai poikkeuksen sattuessa perutaan) ja yhteys palautetaan pooliin.
    Yksi pyyntö = yksi transaktio, joten puolivalmiita muutoksia ei jää kantaan.
    """
    with pool.connection() as conn:
        yield conn


# ---------------------------------------------------------------------------
# Yleiset apufunktiot. Taulu- ja sarakenimet tulevat aina koodista
# (ei käyttäjältä), ja ne lisäksi escapetaan sql.Identifierillä.
#
# Miksi näin: SQL-parametrit (%s) toimivat vain arvoille, eivät taulu- tai
# sarakenimille. Nimiä EI saa liittää kyselyyn f-stringillä, koska se avaisi
# SQL-injektion. sql.Identifier lainaa nimen turvallisesti ("nimi"), ja arvot
# kulkevat erikseen parametreina (sql.Placeholder -> %s), jolloin psycopg
# hoitaa niiden escapeuksen.
# ---------------------------------------------------------------------------

def insert_row(conn, table: str, data: dict) -> dict:
    """Lisää rivin tauluun ja palauttaa sen kokonaisena (myös kannan oletusarvot, id).

    ``data`` on {sarake: arvo}, tyypillisesti Pydantic-mallin ``model_dump()``.
    Esim. {"name": "X", "status": "active"} ->
    INSERT INTO "advertisers" ("name", "status") VALUES (%s, %s) RETURNING *
    """
    cols = list(data.keys())
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
        sql.Identifier(table),
        sql.SQL(", ").join(map(sql.Identifier, cols)),
        sql.SQL(", ").join(sql.Placeholder() * len(cols)),
    )
    return conn.execute(query, list(data.values())).fetchone()


def update_row(conn, table: str, row_id: int, data: dict) -> dict | None:
    """Päivittää annetut sarakkeet riville ``row_id``.

    Palauttaa päivitetyn rivin, tai None jos riviä ei ole (reitti antaa silloin 404).
    Tyhjällä ``data``lla ei ajeta UPDATEa (se olisi virheellistä SQL:ää),
    vaan palautetaan rivi sellaisenaan.
    """
    if not data:
        return get_row(conn, table, row_id)
    assignments = sql.SQL(", ").join(
        sql.SQL("{} = {}").format(sql.Identifier(c), sql.Placeholder()) for c in data
    )
    query = sql.SQL("UPDATE {} SET {} WHERE id = %s RETURNING *").format(
        sql.Identifier(table), assignments
    )
    return conn.execute(query, [*data.values(), row_id]).fetchone()


def get_row(conn, table: str, row_id: int) -> dict | None:
    """Hakee yhden rivin id:llä. None, jos riviä ei löydy."""
    query = sql.SQL("SELECT * FROM {} WHERE id = %s").format(sql.Identifier(table))
    return conn.execute(query, [row_id]).fetchone()


def delete_row(conn, table: str, row_id: int) -> bool:
    """Poistaa rivin id:llä. True, jos jotain poistettiin (rowcount = poistettujen määrä).

    Jos riviin viitataan muualta (vierasavain), PostgreSQL estää poiston ja
    main.py:n integrity_error-käsittelijä muuttaa virheen HTTP 409:ksi.
    """
    query = sql.SQL("DELETE FROM {} WHERE id = %s").format(sql.Identifier(table))
    return conn.execute(query, [row_id]).rowcount > 0
