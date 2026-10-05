from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field

from ..auth import (
    _DUMMY_HASH, MIN_PASSWORD_LENGTH, SESSION_COOKIE, _token_hash, check_password_strength, check_rate_limit, clear_failures,
    clear_session_cookie, create_session, delete_session, get_current_user, hash_password,
    record_failure, set_session_cookie, verify_password,
)
from ..db import get_conn

router = APIRouter(prefix="/api/auth", tags=["Kirjautuminen"])


class LoginIn(BaseModel):
    email: str = Field(min_length=3, max_length=200)
    password: str = Field(min_length=1, max_length=200)


class PasswordChangeIn(BaseModel):
    current_password: str = Field(min_length=1, max_length=200)
    new_password: str = Field(min_length=1, max_length=200)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, conn=Depends(get_conn)):
    email = body.email.strip().lower()
    client = request.client.host if request.client else "?"
    limit_key = f"{email}|{client}"
    check_rate_limit(limit_key)

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
    token = create_session(conn, user["id"])
    set_session_cookie(response, token)
    return {"id": user["id"], "email": user["email"], "name": user["name"], "role": user["role"]}


@router.post("/logout", status_code=204)
def logout(request: Request, response: Response, conn=Depends(get_conn)):
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        delete_session(conn, token)
    clear_session_cookie(response)


@router.get("/me")
def me(user=Depends(get_current_user)):
    return {**user, "min_password_length": MIN_PASSWORD_LENGTH}


@router.put("/password", status_code=204)
def change_password(body: PasswordChangeIn, request: Request,
                    user=Depends(get_current_user), conn=Depends(get_conn)):
    row = conn.execute("SELECT password_hash FROM users WHERE id = %s", [user["id"]]).fetchone()
    if not verify_password(body.current_password, row["password_hash"]):
        raise HTTPException(400, "Nykyinen salasana on väärin.")
    check_password_strength(body.new_password)
    conn.execute("UPDATE users SET password_hash = %s WHERE id = %s",
                 [hash_password(body.new_password), user["id"]])
    # Kirjataan ulos muut sessiot (esim. toinen selain), nykyinen jää voimaan.
    conn.execute(
        "DELETE FROM sessions WHERE user_id = %s AND token_hash <> %s",
        [user["id"], _token_hash(request.cookies.get(SESSION_COOKIE, ""))],
    )
