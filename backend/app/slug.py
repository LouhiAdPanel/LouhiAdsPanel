"""Placement ID:n muodostus mainospaikan nimestä.

"Louhi Konsoli – pääbanneri"  ->  "louhi_konsoli_paabanneri"
"Tukiportaali banneri"        ->  "louhi_tukiportaali_banneri"

Sama sääntö on toteutettu selaimessa (js/placements.js) esikatselua varten;
lopullinen, yksilöllinen tunnus muodostetaan aina palvelimella.
(Jos sääntöä muutetaan, muuta molemmat, jotta esikatselu vastaa lopputulosta.)

Placement ID upotetaan sivustojen mainostagiin, jolla mainos haetaan
(routers/serving.py). Siksi se on lyhyt, URL-turvallinen (a–z, 0–9, _) ja
pysyvä. Käyttäjä: routers/placements.py.
"""
import re
import unicodedata

PREFIX = "louhi_"
# Pituusraja jättää tilaa _2, _3 ... -päätteille (schemas.py sallii enintään 64 merkkiä).
MAX_LEN = 60


def slugify(text: str) -> str:
    """Muuttaa tekstin muotoon, jossa on vain pieniä kirjaimia a–z, numeroita ja '_'.

    Esim. "Pääbanneri 2!" -> "paabanneri_2". Merkit, joille ei ole ASCII-vastinetta
    (esim. '–' tai emoji), pudotetaan pois.
    """
    # NFKD jakaa 'ä':n kahdeksi merkiksi ('a' + kaksi pistettä), ja ascii-muunnos
    # "ignore"-tilassa pudottaa pisteet pois.
    # ä -> a, ö -> o, å -> a ... (poistetaan diakriittiset merkit)
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    # Jokainen sallimattomien merkkien jono (välilyönnit, viivat ...) -> yksi '_'.
    slug = re.sub(r"[^a-z0-9]+", "_", ascii_text.lower()).strip("_")
    return slug


def base_code(name: str) -> str:
    """Placement ID:n perusmuoto nimestä: 'louhi_'-etuliite ja enintään MAX_LEN merkkiä.

    Ei vielä tarkista, onko tunnus jo käytössä (ks. unique_code).
    """
    # Varanimi, jos nimessä ei ole yhtään kelvollista merkkiä (esim. pelkkiä emojeja).
    slug = slugify(name) or "mainospaikka"
    # Vertailu ilman alaviivaa: nimi "Louhi Konsoli" ei saa tuottaa "louhi_louhi_konsoli".
    if not slug.startswith(PREFIX.rstrip("_")):
        slug = PREFIX + slug
    return slug[:MAX_LEN].rstrip("_")


def unique_code(name: str, existing: set[str]) -> str:
    """Palauttaa tunnuksen, jota ei ole vielä käytössä (lisää tarvittaessa _2, _3 ...).

    ``existing`` = tietokannassa jo olevat placement ID:t. Lopullisen
    yksilöllisyyden takaa silti kannan UNIQUE-ehto (samanaikaiset tallennukset).
    """
    base = base_code(name)
    if base not in existing:
        return base
    n = 2
    while f"{base}_{n}" in existing:
        n += 1
    return f"{base}_{n}"
