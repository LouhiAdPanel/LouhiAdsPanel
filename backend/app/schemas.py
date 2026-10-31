"""Pydantic-mallit: validoivat hallintapaneelista tulevan datan ennen tietokantaa.

Kun reitin parametri on tyypiltään esim. ``body: AdvertiserIn``, FastAPI lukee
pyynnön JSON-rungon, muuntaa sen malliksi ja tarkistaa kenttien säännöt
(Field-rajat, pattern-säännölliset lausekkeet, Literal-arvot). Virheellinen data
hylätään automaattisesti HTTP 422 -virheellä ennen kuin reitin koodia ajetaan.
Mallit näkyvät myös /docs-sivulla.

"In"-pääte = selaimesta palvelimelle tuleva data (luonti ja muokkaus). Kannan
CHECK-ehdot (db/schema.sql) ovat toinen, varmistava suojakerros.
Käyttäjät: routers/*.py.
"""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

# Literal = kenttä hyväksyy vain luetellut arvot (vastaa kannan CHECK-ehtoja).
ActiveStatus = Literal["active", "inactive"]
AdvertiserStatus = Literal["active", "inactive", "suspended"]   # suspended = keskeytetty
PausableStatus = Literal["active", "inactive", "paused"]        # mainospaikka ja mainos
CampaignStatus = Literal["draft", "active", "paused", "archived"]


class AdvertiserIn(BaseModel):
    """Mainostajan luonti/muokkaus."""

    # pattern ^https?:// sallii vain http(s)-osoitteet (ei esim. javascript:-linkkejä).
    name: str = Field(min_length=1, max_length=100)
    website_url: str | None = Field(default=None, pattern=r"^https?://")
    status: AdvertiserStatus = "active"


EnvironmentChannel = Literal["web", "email"]   # web = verkkosivu, email = sähköposti


class EnvironmentIn(BaseModel):
    """Ympäristön luonti/muokkaus (Ympäristöt-sivu, vain admin).

    channel kertoo, miten ympäristön mainospaikat upotetaan: 'web' = mainostagi
    louhi-ads.js, 'email' = kuva + linkki -upotus uutiskirjeeseen (ks. serving.py).
    """

    name: str = Field(min_length=1, max_length=100)
    channel: EnvironmentChannel = "web"
    description: str | None = Field(default=None, max_length=500)


class PlacementIn(BaseModel):
    """Mainospaikan luonti/muokkaus. width/height = suurin sallittu mainoksen koko pikseleinä."""

    name: str = Field(min_length=1, max_length=150)
    # Placement ID muodostetaan automaattisesti nimestä (routers/placements.py).
    # Tunnusta ei voi muuttaa jälkikäteen, koska se on upotettu sivustojen koodiin.
    code: str | None = Field(default=None, min_length=2, max_length=64, pattern=r"^[a-z0-9_]+$",
                             description="Ei tarvitse antaa – muodostuu nimestä, esim. louhi_konsoli_paabanneri")
    environment: str = Field(min_length=1, max_length=100)
    width: int = Field(gt=0, le=5000)
    height: int = Field(gt=0, le=5000)
    status: PausableStatus = "active"
    notes: str | None = None


class CampaignIn(BaseModel):
    """Kampanjan luonti/muokkaus.

    priority: ei enää käytössä (sarake säilyy tietokannassa). Mainosten näkyvyys
    määräytyy mainoksen omasta painoarvosta (placings.priority), ks. CreativeIn.
    placement_ids: kampanjan sallitut mainospaikat (taulu campaign_placements).
    Kampanjan mainokset voi sijoittaa vain näihin paikkoihin.
    """

    advertiser_id: int
    name: str = Field(min_length=1, max_length=150)
    start_time: datetime | None = None
    end_time: datetime | None = None
    priority: int = Field(default=0, ge=0, le=100)
    status: CampaignStatus = "draft"
    utm_campaign: str | None = Field(default=None, max_length=100)
    # default_factory: jokainen olio saa oman tyhjän listan (ei jaettua oletuslistaa).
    placement_ids: list[int] = Field(default_factory=list)
    # Kampanjaan liitettävät mainokset (lomakkeen monivalinta "Mainokset"). None = ei muuteta
    # (esim. vanhat kutsut ilman kenttää). Ks. routers/campaigns.py, _set_creatives.
    creative_ids: list[int] | None = None

    @model_validator(mode="after")
    def check_dates(self):
        """Kenttien väliset säännöt, jotka eivät mahdu yksittäisen kentän Fieldiin.

        mode="after" = ajetaan, kun yksittäiset kentät on jo tarkistettu.
        ValueError muuttuu automaattisesti HTTP 422 -virheeksi.
        """
        if self.start_time and self.end_time and self.end_time <= self.start_time:
            raise ValueError("Päättymisajan on oltava aloitusajan jälkeen.")
        if self.status == "active" and not (self.start_time and self.end_time):
            raise ValueError("Aktiivisella kampanjalla on oltava aloitus- ja päättymisaika.")
        return self


class CampaignStatusIn(BaseModel):
    """Pelkän tilan vaihto (esim. keskeytys tai aktivointi) ilman koko kampanjan lähettämistä."""

    status: CampaignStatus


class CreativeIn(BaseModel):
    """Mainoksen (kuva + linkki) ja sen sijoitusten luonti/muokkaus.

    Mainos kuuluu mainostajalle (advertiser_id, pakollinen). Kampanja on valinnainen.
    Kuva ladataan ensin erikseen (media.py), ja tähän tulee sen /media/-osoite.

    Sijoitukset (placings): jokaisesta valitusta mainospaikasta (placement_ids, vähintään
    yksi) tehdään sijoitus, jolla on sama painoarvo (priority), start_time, end_time ja
    campaign_id. Tarkistukset ovat routers/creatives.py:n _prepare-funktiossa, jotta
    virheviestit ovat suomeksi.
    """

    advertiser_id: int
    campaign_id: int | None = Field(default=None, description="Valinnainen kampanja")
    name: str = Field(min_length=1, max_length=150)
    image_url: str = Field(min_length=1, pattern=r"^(https?://|/media/)",
                           description="Ladattu kuva (/media/...) tai ulkoinen URL")
    target_url: str = Field(pattern=r"^https?://")
    alt_text: str = Field(default="", max_length=200)
    # Ladatun kuvan (/media/...) mitat luetaan aina tiedostosta palvelimella.
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    status: PausableStatus = "active"
    # --- sijoitusten yhteiset asetukset ---
    placement_ids: list[int] = Field(default_factory=list,
                                     description="Mainospaikkojen id:t, joissa mainos näytetään")
    # Painoarvo 0–100 (lomakkeen Painoarvo; tietokannassa placings.priority, kaavion
    # PLACING.priority). Osuus näytöistä = painoarvo / paikan painoarvojen summa. 0 = ei näytetä.
    priority: int = Field(default=50, ge=0, le=100, description="Painoarvo 0–100 (0 = ei näytetä)")
    # Vanha kenttä, ei enää käytössä (hyväksytään yhteensopivuuden vuoksi, arvo ohitetaan).
    weight: int | None = Field(default=None, ge=0, le=100, description="Ei käytössä")
    start_time: datetime | None = Field(default=None, description="Tyhjä = heti")
    end_time: datetime | None = Field(default=None, description="Tyhjä = toistaiseksi")

    @model_validator(mode="after")
    def check_dates(self):
        """Sijoituksen päättymisajan on oltava alkamisajan jälkeen."""
        if self.start_time and self.end_time and self.end_time <= self.start_time:
            raise ValueError("Päättymisajan on oltava alkamisajan jälkeen.")
        return self
