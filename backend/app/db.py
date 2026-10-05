"""Tietokantayhteys: yhteyspooli ja apufunktiot yksinkertaisiin CRUD-kyselyihin."""
import os

from dotenv import load_dotenv
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/louhiads"
)

pool = ConnectionPool(
    DATABASE_URL,
    min_size=1,
    max_size=10,
    kwargs={"row_factory": dict_row},
    open=False,  # avataan main.py:n lifespanissa
)


def get_conn():
    """FastAPI-riippuvuus: antaa yhteyden poolista.
    Onnistunut pyyntö commitoidaan, virhe perutaan (rollback)."""
    with pool.connection() as conn:
        yield conn


# ---------------------------------------------------------------------------
# Yleiset apufunktiot. Taulu- ja sarakenimet tulevat aina koodista
# (ei käyttäjältä), ja ne lisäksi escapetaan sql.Identifierillä.
# ---------------------------------------------------------------------------

def insert_row(conn, table: str, data: dict) -> dict:
    cols = list(data.keys())
    query = sql.SQL("INSERT INTO {} ({}) VALUES ({}) RETURNING *").format(
        sql.Identifier(table),
        sql.SQL(", ").join(map(sql.Identifier, cols)),
        sql.SQL(", ").join(sql.Placeholder() * len(cols)),
    )
    return conn.execute(query, list(data.values())).fetchone()


def update_row(conn, table: str, row_id: int, data: dict) -> dict | None:
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
    query = sql.SQL("SELECT * FROM {} WHERE id = %s").format(sql.Identifier(table))
    return conn.execute(query, [row_id]).fetchone()


def delete_row(conn, table: str, row_id: int) -> bool:
    query = sql.SQL("DELETE FROM {} WHERE id = %s").format(sql.Identifier(table))
    return conn.execute(query, [row_id]).rowcount > 0
