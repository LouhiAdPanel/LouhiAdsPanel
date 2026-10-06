"""Mainoskuvien tallennus (määrittely luku 7: MVP-aineistot JPG ja PNG).

Kuvat tallennetaan tietokantaan (taulu media_files), jotta ne säilyvät myös
pilvipalvelimella, jonka levy tyhjenee uudelleenkäynnistyksessä (esim. Render).
Kuva tarjoillaan osoitteesta /media/<nimi> (ks. main.py). Tiedostotyyppi
tarkistetaan tiedoston sisällöstä (ei pelkästä nimestä tai selaimen ilmoittamasta tyypistä).

Vanhat, levylle tallennetut kuvat (LouhiAds/media/) toimivat edelleen varalla.
"""
import os
import secrets
import struct
from pathlib import Path

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", Path(__file__).resolve().parents[2] / "media"))
MEDIA_URL_PREFIX = "/media/"
MAX_UPLOAD_BYTES = int(float(os.getenv("MAX_UPLOAD_MB", "5")) * 1024 * 1024)
CONTENT_TYPES = {"png": "image/png", "jpg": "image/jpeg"}


class InvalidImage(ValueError):
    pass


# ---------------------------------------------------------------------------
# Tiedostotyypin ja mittojen tunnistus
# ---------------------------------------------------------------------------
def _png_size(data: bytes) -> tuple[int, int]:
    # IHDR-lohko alkaa heti tunnisteen jälkeen: leveys ja korkeus 4 tavua kumpikin
    if len(data) < 24 or data[12:16] != b"IHDR":
        raise InvalidImage("PNG-tiedosto on vioittunut.")
    return struct.unpack(">II", data[16:24])


def _jpeg_size(data: bytes) -> tuple[int, int]:
    # Käydään JPEG-segmentit läpi, kunnes löytyy SOF-segmentti (sisältää mitat)
    i = 2
    while i + 9 < len(data):
        if data[i] != 0xFF:
            i += 1
            continue
        marker = data[i + 1]
        if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:  # segmentit ilman pituutta
            i += 2
            continue
        length = struct.unpack(">H", data[i + 2:i + 4])[0]
        if marker in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
            height, width = struct.unpack(">HH", data[i + 5:i + 9])
            return width, height
        i += 2 + length
    raise InvalidImage("JPEG-tiedoston mittoja ei voitu lukea.")


def inspect_image(data: bytes) -> tuple[str, int, int]:
    """Palauttaa (pääte, leveys, korkeus). Hyväksyy vain PNG:n ja JPEG:n."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        ext, (w, h) = "png", _png_size(data)
    elif data.startswith(b"\xff\xd8\xff"):
        ext, (w, h) = "jpg", _jpeg_size(data)
    else:
        raise InvalidImage("Vain JPG- ja PNG-kuvat ovat sallittuja.")
    if not (0 < w <= 10000 and 0 < h <= 10000):
        raise InvalidImage("Kuvan mitat eivät ole kelvolliset.")
    return ext, w, h


def _media_name(image_url: str | None) -> str | None:
    """'/media/abc.png' -> 'abc.png'. None, jos ulkoinen URL tai epäkelpo nimi."""
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
    if not data:
        raise InvalidImage("Tiedosto on tyhjä.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise InvalidImage(f"Kuva on liian suuri (enintään {MAX_UPLOAD_BYTES // (1024 * 1024)} Mt).")
    ext, width, height = inspect_image(data)
    name = f"{secrets.token_hex(12)}.{ext}"
    conn.execute(
        """INSERT INTO media_files (name, content_type, data, width, height, bytes)
           VALUES (%s, %s, %s, %s, %s, %s)""",
        [name, CONTENT_TYPES[ext], data, width, height, len(data)],
    )
    return {"image_url": MEDIA_URL_PREFIX + name, "width": width, "height": height, "bytes": len(data)}


def get_image(conn, name: str) -> tuple[bytes, str] | None:
    """Palauttaa (data, content_type) tai None. Varalla vanhat levylle tallennetut kuvat."""
    if _media_name(MEDIA_URL_PREFIX + name) is None:
        return None
    row = conn.execute("SELECT data, content_type FROM media_files WHERE name = %s", [name]).fetchone()
    if row:
        return bytes(row["data"]), row["content_type"]
    path = MEDIA_DIR / name
    if path.is_file():
        data = path.read_bytes()
        return data, CONTENT_TYPES.get(name.rsplit(".", 1)[-1], "application/octet-stream")
    return None


def local_image_size(conn, image_url: str | None) -> tuple[int, int] | None:
    """Palvelimelle ladatun kuvan todelliset mitat (None, jos ulkoinen URL tai kuvaa ei ole)."""
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
    try:
        (MEDIA_DIR / name).unlink()
    except FileNotFoundError:
        pass
