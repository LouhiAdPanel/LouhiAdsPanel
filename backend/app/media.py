"""Mainoskuvien tallennus (määrittely luku 7: MVP-aineistot JPG ja PNG).

Kuvat tallennetaan tietokantaan (taulu media_files), jotta ne säilyvät myös
pilvipalvelimella, jonka levy tyhjenee uudelleenkäynnistyksessä (esim. Render).
Kuva tarjoillaan osoitteesta /media/<nimi> (ks. main.py). Tiedostotyyppi
tarkistetaan tiedoston sisällöstä (ei pelkästä nimestä tai selaimen ilmoittamasta tyypistä).

Vanhat, levylle tallennetut kuvat (LouhiAds/media/) toimivat edelleen varalla.

Liittymät: routers/creatives.py tallentaa ja poistaa kuvat sekä lukee niiden
mitat, main.py tarjoilee ne (get_image). Taulu: db/migrations/003_media_in_db.sql.
"""
import os
import secrets
import struct
from pathlib import Path

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", Path(__file__).resolve().parents[2] / "media"))
MEDIA_URL_PREFIX = "/media/"
# Kokoraja estää valtavien tiedostojen tallentamisen kantaan (oletus 5 Mt).
MAX_UPLOAD_BYTES = int(float(os.getenv("MAX_UPLOAD_MB", "5")) * 1024 * 1024)
# Tiedostopääte -> HTTP Content-Type, jolla kuva tarjoillaan selaimelle.
CONTENT_TYPES = {"png": "image/png", "jpg": "image/jpeg"}


class InvalidImage(ValueError):
    """Kuva hylättiin (väärä tyyppi, vioittunut, liian suuri).

    Viesti näytetään käyttäjälle; routers/creatives.py muuttaa sen HTTP 422 -virheeksi.
    """
    pass


# ---------------------------------------------------------------------------
# Tiedostotyypin ja mittojen tunnistus
# ---------------------------------------------------------------------------
def _png_size(data: bytes) -> tuple[int, int]:
    """Lukee PNG-kuvan (leveys, korkeus) tiedoston otsakkeesta."""
    # Rakenne: 8 tavun tunniste, lohkon pituus (4) ja tyyppi "IHDR" (4).
    # IHDR-lohko alkaa heti tunnisteen jälkeen: leveys ja korkeus 4 tavua kumpikin
    if len(data) < 24 or data[12:16] != b"IHDR":
        raise InvalidImage("PNG-tiedosto on vioittunut.")
    return struct.unpack(">II", data[16:24])  # ">II" = kaksi 32-bittistä, big-endian


def _jpeg_size(data: bytes) -> tuple[int, int]:
    """Lukee JPEG-kuvan (leveys, korkeus) ilman kuvankäsittelykirjastoa.

    JPEG koostuu segmenteistä: 0xFF, tyyppitavu (marker), 2 tavun pituus ja data.
    Mitat ovat SOF-segmentissä (Start Of Frame). Ulkoista kirjastoa (esim. Pillow)
    ei tarvita, koska mittojen lukemiseen riittää tämä.
    """
    # Käydään JPEG-segmentit läpi, kunnes löytyy SOF-segmentti (sisältää mitat)
    i = 2  # ohitetaan alun SOI-tunniste FF D8
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:  # segmentit ilman pituutta
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        # SOF-tyypit (C4, C8 ja CC ovat muita segmenttejä). Pituuden jälkeen tulee
        # 1 tavu tarkkuutta, sitten korkeus ja leveys (tässä järjestyksessä).
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height, width = struct.unpack(">HH", data[i + 5:i + 9])
            return width, height
        i += 2 + length  # hypätään seuraavaan segmenttiin (pituus sisältää omat 2 tavuaan)
    raise InvalidImage("JPEG-tiedoston mittoja ei voitu lukea.")


def inspect_image(data: bytes) -> tuple[str, int, int]:
    """Palauttaa (pääte, leveys, korkeus). Hyväksyy vain PNG:n ja JPEG:n.

    Tyyppi tunnistetaan tiedoston alun "magic bytes" -tunnisteesta. Tiedostonimeen
    tai selaimen ilmoittamaan tyyppiin ei luoteta, koska ne voi väärentää
    (esim. HTML- tai SVG-tiedosto nimellä kuva.png voisi sisältää skriptejä).
    Heittää InvalidImage-virheen, jos tiedosto ei kelpaa.
    """
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        ext, (w, h) = "png", _png_size(data)
    elif data.startswith(b"\xff\xd8\xff"):
        ext, (w, h) = "jpg", _jpeg_size(data)
    else:
        raise InvalidImage("Vain JPG- ja PNG-kuvat ovat sallittuja.")
    # Järkevyystarkistus: vioittunut tai tarkoituksella muokattu otsake voi antaa
    # nollan tai valtavia mittoja.
    if not (0 < w <= 10000 and 0 < h <= 10000):
        raise InvalidImage("Kuvan mitat eivät ole kelvolliset.")
    return ext, w, h


def _media_name(image_url: str | None) -> str | None:
    """'/media/abc.png' -> 'abc.png'. None, jos ulkoinen URL tai epäkelpo nimi.

    Tietoturvan kannalta tärkeä: nimeä käytetään levypolussa (MEDIA_DIR / nimi),
    joten kauttaviivat ja pisteellä alkavat nimet (esim. '..') hylätään.
    Muuten muokattu nimi voisi osoittaa media-kansion ulkopuolelle (path traversal).
    """
    if not image_url or not image_url.startswith(MEDIA_URL_PREFIX):
        return None
    name = image_url[len(MEDIA_URL_PREFIX):]
    if not name or "/" in name or "\\" in name or name.startswith("."):
        return None  # ei koskaan polkuja media-kansion ulkopuolelle
    return name


# ---------------------------------------------------------------------------
# Tallennus, haku ja poisto (tietokanta)
# ---------------------------------------------------------------------------
def save_image(conn, data: bytes) -> dict:
    """Tarkistaa ladatun kuvan ja tallentaa sen media_files-tauluun.

    Palauttaa {"image_url", "width", "height", "bytes"}; image_url tallennetaan
    mainoksen (creatives) tietoihin. Virheellinen kuva -> InvalidImage.
    """
    if not data:
        raise InvalidImage("Tiedosto on tyhjä.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise InvalidImage(f"Kuva on liian suuri (enintään {MAX_UPLOAD_BYTES // (1024 * 1024)} Mt).")
    ext, width, height = inspect_image(data)
    # Satunnainen nimi: ei törmäyksiä, käyttäjän antama tiedostonimi ei päädy
    # mihinkään, eikä muiden kuvia voi arvata. Koska sisältö ei koskaan muutu
    # samalla nimellä, kuvalle voi antaa pitkän välimuistiajan (ks. main.py).
    name = f"{secrets.token_hex(12)}.{ext}"
    conn.execute(
        """INSERT INTO media_files (name, content_type, data, width, height, bytes)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        [name, CONTENT_TYPES[ext], data, width, height, len(data)],
    )
    return {"image_url": MEDIA_URL_PREFIX + name, "width": width, "height": height, "bytes": len(data)}


def get_image(conn, name: str) -> tuple[bytes, str] | None:
    """Palauttaa (data, content_type) tai None. Varalla vanhat levylle tallennetut kuvat."""
    # Nimi tulee suoraan URL:sta, joten se validoidaan ennen kantaa ja levyä.
    if _media_name(MEDIA_URL_PREFIX + name) is None:
        return None
    row = conn.execute("SELECT data, content_type FROM media_files WHERE name = %s", [name]).fetchone()
    if row:
        # BYTEA-sarake palautuu memoryview-oliona; Response tarvitsee bytes-arvon.
        return bytes(row["data"]), row["content_type"]
    # Varalla: ennen migraatiota 003 kuvat tallennettiin levylle.
    path = MEDIA_DIR / name
    if path.is_file():
        data = path.read_bytes()
        return data, CONTENT_TYPES.get(name.rsplit(".", 1)[-1], "application/octet-stream")
    return None


def local_image_size(conn, image_url: str | None) -> tuple[int, int] | None:
    """Palvelimelle ladatun kuvan todelliset mitat (None, jos ulkoinen URL tai kuvaa ei ole).

    Mainosta tallennettaessa käytetään näitä mittoja käyttäjän ilmoittamien sijaan,
    jotta mainoksen koko voidaan luotettavasti verrata mainospaikan kokoon.
    """
    name = _media_name(image_url)
    if not name:
        return None
    row = conn.execute("SELECT width, height FROM media_files WHERE name = %s", [name]).fetchone()
    if row:
        return row["width"], row["height"]
    path = MEDIA_DIR / name
    if path.is_file():
        try:
            _, w, h = inspect_image(path.read_bytes())
            return w, h
        except InvalidImage:
            return None
    return None


def delete_local_image(conn, image_url: str | None) -> None:
    """Poistaa palvelimelle ladatun kuvan. Ulkoisiin URL-osoitteisiin ei kosketa."""
    name = _media_name(image_url)
    if not name:
        return
    conn.execute("DELETE FROM media_files WHERE name = %s", [name])
    # Poistetaan myös mahdollinen vanha levykopio; puuttuva tiedosto ei ole virhe.
    try:
        (MEDIA_DIR / name).unlink()
    except FileNotFoundError:
        pass
