"""Käyttäjähallinta – vain Admin (määrittely luku 14)."""
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from ..auth import check_password_strength, hash_password, require_admin
from ..db import get_conn

router = APIRouter(prefix="/api/users", tags=["Käyttäjät"], dependencies=[Depends(require_admin)])

Role = Literal["admin", "editor"]
FIELDS = "id, email, name, role, is_active, last_login_at, created_at"


class UserCreate(BaseModel):
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    name: str = Field(min_length=1, max_length=100)
    role: Role = "editor"
    is_active: bool = True
    password: str = Field(min_length=1, max_length=200)


class UserUpdate(BaseModel):
    email: str = Field(min_length=3, max_length=200, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    name: str = Field(min_length=1, max_length=100)
    role: Role
    is_active: bool
    password: str | None = Field(default=None, max_length=200, description="Tyhjä = ei muuteta")


def _other_active_admins(conn, user_id: int) -> int:
    return conn.execute(
        "SELECT count(*) AS n FROM users WHERE role = 'admin' AND is_active AND id <> %s", [user_id]
    ).fetchone()["n"]


@router.get("")
def list_users(conn=Depends(get_conn)):
    return conn.execute(f"SELECT {FIELDS} FROM users ORDER BY name").fetchall()


@router.post("", status_code=201)
def create_user(body: UserCreate, conn=Depends(get_conn)):
    check_password_strength(body.password)
    return conn.execute(
        f"""INSERT INTO users (email, name, role, is_active, password_hash)
            VALUES (lower(%s), %s, %s, %s, %s) RETURNING {FIELDS}""",
        [body.email.strip(), body.name, body.role, body.is_active, hash_password(body.password)],
    ).fetchone()


@router.put("/{user_id}")
def update_user(user_id: int, body: UserUpdate, me=Depends(require_admin), conn=Depends(get_conn)):
    # Järjestelmään on aina jäätävä vähintään yksi aktiivinen admin.
    losing_admin = body.role != "admin" or not body.is_active
    if losing_admin and _other_active_admins(conn, user_id) == 0:
        raise HTTPException(409, "Järjestelmässä on oltava vähintään yksi aktiivinen admin.")

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
    if not body.is_active or (body.password and user_id != me["id"]):
        conn.execute("DELETE FROM sessions WHERE user_id = %s", [user_id])
    return row


@router.delete("/{user_id}", status_code=204)
def delete_user(user_id: int, me=Depends(require_admin), conn=Depends(get_conn)):
    if user_id == me["id"]:
        raise HTTPException(409, "Et voi poistaa omaa tunnustasi.")
    if _other_active_admins(conn, user_id) == 0:
        raise HTTPException(409, "Järjestelmässä on oltava vähintään yksi aktiivinen admin.")
    if conn.execute("DELETE FROM users WHERE id = %s", [user_id]).rowcount == 0:
        raise HTTPException(404, "Käyttäjää ei löytynyt.")
