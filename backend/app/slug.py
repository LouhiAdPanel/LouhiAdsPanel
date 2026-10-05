"""Placement ID:n muodostus mainospaikan nimestä.

"Louhi Konsoli – pääbanneri"  ->  "louhi_konsoli_paabanneri"
"Tukiportaali banneri"        ->  "louhi_tukiportaali_banneri"

Sama sääntö on toteutettu selaimessa (js/placements.js) esikatselua varten;
lopullinen, yksilöllinen tunnus muodostetaan aina palvelimella.
"""
import re
import unicodedata

PREFIX = "louhi_"
MAX_LEN = 60


def slugify(text: str) -> str:
    # ä -> a, ö -> o, å -> a ... (poistetaan diakriittiset merkit)
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    slug = re.sub(r"[^a-z0-9]+", "_", ascii_text.lower()).strip("_")
    return slug


def base_code(name: str) -> str:
    slug = slugify(name) or "mainospaikka"
    if not slug.startswith(PREFIX.rstrip("_")):
        slug = PREFIX + slug
    return slug[:MAX_LEN].rstrip("_")


def unique_code(name: str, existing: set[str]) -> str:
    """Palauttaa tunnuksen, jota ei ole vielä käytössä (lisää tarvittaessa _2, _3 ...)."""
    base = base_code(name)
    if base not in existing:
        return base
    n = 2
    while f"{base}_{n}" in existing:
        n += 1
    return f"{base}_{n}"
