"""Luo admin-käyttäjän tai asettaa olemassa olevalle uuden salasanan.

Aja backend-kansiossa (virtuaaliympäristö aktiivisena):
    python -m app.create_admin

Komentoriviskripti, ei osa verkkopalvelinta. Tarvitaan, koska käyttäjiä voi
hallintapaneelissa luoda vain admin: ensimmäinen admin on luotava tällä.
Toimii myös "unohtuneen salasanan" palautuksena. Käyttää samaa tietokantaa
(db.DATABASE_URL, eli .env) ja samaa salasanatiivistettä (auth.hash_password)
kuin palvelin. ``-m app.create_admin`` tarvitaan, jotta suhteelliset importit
(``from .auth``) toimivat.
"""
import getpass

import psycopg
from psycopg.rows import dict_row

from .auth import MIN_PASSWORD_LENGTH, hash_password
from .db import DATABASE_URL


def main():
    """Kysyy sähköpostin, nimen ja salasanan ja tallentaa admin-käyttäjän."""
    print("Louhi Ads – admin-käyttäjän luonti\n")
    email = input("Sähköposti: ").strip().lower()
    if "@" not in email:
        raise SystemExit("Virheellinen sähköpostiosoite.")

    # Yksittäinen yhteys riittää (ei poolia). with-lohko commitoi lopussa,
    # tai peruu muutokset, jos skripti keskeytetään (esim. Ctrl+C).
    with psycopg.connect(DATABASE_URL, row_factory=dict_row) as conn:
        # lower(): sähköpostin kirjainkoolla ei ole väliä (sama kuin kirjautumisessa).
        existing = conn.execute("SELECT id, name FROM users WHERE lower(email) = %s", [email]).fetchone()
        if existing:
            print(f"Käyttäjä löytyi: {existing['name']}. Asetetaan uusi salasana ja admin-rooli.")
            name = existing["name"]
        else:
            name = input("Nimi: ").strip() or email

        # getpass ei näytä kirjoitettua salasanaa eikä tallenna sitä komentohistoriaan.
        while True:
            pw = getpass.getpass(f"Salasana (väh. {MIN_PASSWORD_LENGTH} merkkiä, ei näy kirjoittaessa): ")
            if len(pw) < MIN_PASSWORD_LENGTH:
                print("Liian lyhyt, yritä uudelleen.")
                continue
            if pw != getpass.getpass("Salasana uudelleen: "):
                print("Salasanat eivät täsmää, yritä uudelleen.")
                continue
            break

        # "Upsert": uusi käyttäjä lisätään, olemassa olevalle (sama email) päivitetään
        # salasana, admin-rooli ja aktiivisuus. Kantaan menee vain tiiviste.
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
