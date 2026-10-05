"""Mainoskuvien tallennus (määrittely luku 7: MVP-aineistot JPG ja PNG).

Kuvat tallennetaan LouhiAds/media/-kansioon satunnaisella nimellä ja
tarjoillaan osoitteesta /media/<nimi>. Tiedostotyyppi tarkistetaan
tiedoston sisällöstä (ei pelkästä nimestä tai selaimen ilmoittamasta tyypistä).
"""
import os
import secrets
import struct
from pathlib import Path

MEDIA_DIR = Path(os.getenv("MEDIA_DIR", Path(__file__).resolve().parents[2] / "media"))
MEDIA_URL_PREFIX = "/media/"
MAX_UPLOAD_BYTES = int(float(os.getenv("MAX_UPLOAD_MB", "5")) * 1024 * 1024)


class InvalidImage(ValueError):
    pass


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


def save_image(data: bytes) -> dict:
    if not data:
        raise InvalidImage("Tiedosto on tyhjä.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise InvalidImage(f"Kuva on liian suuri (enintään {MAX_UPLOAD_BYTES // (1024 * 1024)} Mt).")
    ext, width, height = inspect_image(data)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    name = f"{secrets.token_hex(12)}.{ext}"
    (MEDIA_DIR / name).write_bytes(data)
    return {"image_url": MEDIA_URL_PREFIX + name, "width": width, "height": height, "bytes": len(data)}


def delete_local_image(image_url: str | None) -> None:
    """Poistaa palvelimelle ladatun kuvan. Ulkoisiin URL-osoitteisiin ei kosketa."""
    if not image_url or not image_url.startswith(MEDIA_URL_PREFIX):
        return
    name = image_url[len(MEDIA_URL_PREFIX):]
    if "/" in name or "\\" in name or name.startswith("."):
        return  # ei koskaan polkuja media-kansion ulkopuolelle
    try:
        (MEDIA_DIR / name).unlink()
    except FileNotFoundError:
        pass
