"""Pydantic-mallit: validoivat hallintapaneelista tulevan datan ennen tietokantaa."""
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator

ActiveStatus = Literal["active", "inactive"]
CampaignStatus = Literal["draft", "active", "paused", "archived"]


class AdvertiserIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    website_url: str | None = Field(default=None, pattern=r"^https?://")
    status: ActiveStatus = "active"


class PlacementIn(BaseModel):
    name: str = Field(min_length=1, max_length=150)
    # Placement ID muodostetaan automaattisesti nimestä (routers/placements.py).
    # Tunnusta ei voi muuttaa jälkikäteen, koska se on upotettu sivustojen koodiin.
    code: str | None = Field(default=None, min_length=2, max_length=64, pattern=r"^[a-z0-9_]+$",
                             description="Ei tarvitse antaa – muodostuu nimestä, esim. louhi_konsoli_paabanneri")
    environment: str = Field(min_length=1, max_length=100)
    width: int = Field(gt=0, le=5000)
    height: int = Field(gt=0, le=5000)
    status: ActiveStatus = "active"
    notes: str | None = None


class CampaignIn(BaseModel):
    advertiser_id: int
    name: str = Field(min_length=1, max_length=150)
    start_time: datetime | None = None
    end_time: datetime | None = None
    priority: int = Field(default=0, ge=0, le=100)
    status: CampaignStatus = "draft"
    utm_campaign: str | None = Field(default=None, max_length=100)
    placement_ids: list[int] = Field(default_factory=list)

    @model_validator(mode="after")
    def check_dates(self):
        if self.start_time and self.end_time and self.end_time <= self.start_time:
            raise ValueError("Päättymisajan on oltava aloitusajan jälkeen.")
        if self.status == "active" and not (self.start_time and self.end_time):
            raise ValueError("Aktiivisella kampanjalla on oltava aloitus- ja päättymisaika.")
        return self


class CampaignStatusIn(BaseModel):
    status: CampaignStatus


class CreativeIn(BaseModel):
    campaign_id: int | None = Field(default=None, description="Valinnainen – mainos voi olla ilman kampanjaa")
    name: str = Field(min_length=1, max_length=150)
    image_url: str = Field(min_length=1, pattern=r"^(https?://|/media/)",
                           description="Ladattu kuva (/media/...) tai ulkoinen URL")
    target_url: str = Field(pattern=r"^https?://")
    alt_text: str = Field(default="", max_length=200)
    # Ladatun kuvan (/media/...) mitat luetaan aina tiedostosta palvelimella.
    width: int | None = Field(default=None, gt=0)
    height: int | None = Field(default=None, gt=0)
    weight: int = Field(default=1, ge=0, le=100)
    status: ActiveStatus = "active"
