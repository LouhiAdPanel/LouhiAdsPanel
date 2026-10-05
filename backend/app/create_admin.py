"""Luo admin-käyttäjän tai asettaa olemassa olevalle uuden salasanan.

Aja backend-kansiossa (virtuaaliympäristö aktiivisena):
    python -m app.create_admin
"""
import getpass

import psycopg
from psycopg.rows import dict_row

from .auth import MIN_PASSWORD_LENGTH, hash_password
from .db import DATABASE_URL


def main():
    print("Louhi Ads – admin-käyttäjän luonti\n")
    email = input("Sähköposti: ").strip().lower()
    if "@" not in email:
        raise SystemExit("Virheellinen sähköpostiosoite.")

    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        existing = conn.execute("SELECT id, name FROM users WHERE lower(email) = %s", [email]).fetchone()
        if existing:
            print(f"Käyttäjä löytyi: {existing['name']}. Asetetaan uusi salasana ja admin-rooli.")
            name = existing["name"]
        else:
            name = input("Nimi: ").strip() or email

        while True:
            pw = getpass.getpass(f"Salasana (väh. {MIN_PASSWORD_LENGTH} merkkiä, ei näy kirjoittaessa): ")
            if len(pw) < MIN_PASSWORD_LENGTH:
                print("Liian lyhyt, yritä uudelleen.")
                continue
            if pw != getpass.getpass("Salasana uudelleen: "):
                print("Salasanat eivät täsmää, yritä uudelleen.")
                continue
            break

        conn.execute(
            """INSERT INTO users (email, name, password_hash, role, is_active)
               VALUES (%s, %s, %s, 'admin', TRUE)
               ON CONFLICT (email) DO UPDATE
                 SET password_hash = EXCLUDED.password_hash, role = 'admin', is_active = TRUE""",
            [email, name, hash_password(pw)],
        )
    print(f"\nValmis. Kirjaudu osoitteessa http://localhost:8000/login.html tunnuksella {email}")


if __name__ == "__main__":
    main()
