# Louhi Ads – tietokanta

| Tiedosto     | Sisältö |
|--------------|---------|
| `schema.sql` | Taulut, indeksit, triggerit ja raportointinäkymät. **Pudottaa olemassa olevat taulut** – vain kehityskäyttöön. |
| `seed.sql`   | Testidata (vain kehityskoneelle): ympäristöt, mainostajat, mainospaikat (myös demosivun ja uutiskirjeen), kampanjat ja niiden mainospaikat, mainokset, sijoitukset sekä keinotekoiset näytöt/klikkaukset 14 päivältä. Tuotantokantaan (Neon) ei ajeta: siellä raportit näyttävät vain oikeat näytöt ja klikit. |
| `migrations/` | Muutokset olemassa olevaan kantaan ilman datan poistoa. Aja numerojärjestyksessä ne, joita kantaan ei ole vielä ajettu. |

| Migraatio | Muutos |
|-----------|--------|
| `001_auth.sql` | Kirjautuminen (users, sessions) |
| `002_creative_campaign_optional.sql` | Mainoksen kampanja valinnaiseksi |
| `003_media_in_db.sql` | Mainoskuvat tietokantaan |
| `004_demopage_placements.sql` | Demosivun kolme mainospaikkaa |
| `005_creative_placements.sql` | Mainoksen omat mainospaikat (välivaihe, korvautuu 006:lla) |
| `006_placings.sql` | Uusi tietomalli: sijoitukset (`placings`, kaavion PLACING) |
| `007_campaign_placements.sql` | Kampanjan sallitut mainospaikat (`campaign_placements`) |
| `008_painoarvo.sql` | Paino ja prioriteetti yhdistetään painoarvoksi (`placings.priority`, 0–100). Vain datan muunnos, ei rakennemuutoksia. |
| `009_environments.sql` | Ympäristöt omaan tauluun (`environments`, kanava web/email); `placements.environment` viittaa nimeen. Uutiskirjeen ympäristö ja kaksi mainospaikkaa. |

## Käyttöönotto (Windows, PowerShell)

Aja LouhiAds-kansiossa. `psql` kysyy postgres-käyttäjän salasanan.

```powershell
# 1. Luo tietokanta (vain kerran)
psql -U postgres -c "CREATE DATABASE louhiads ENCODING 'UTF8'"

# 2. Luo taulut ja lisää testidata (voi ajaa uudelleen milloin vain)
psql -U postgres -d louhiads -v ON_ERROR_STOP=1 -f db/schema.sql -f db/seed.sql
```

Jos `psql` ei löydy, lisää PATHiin esim. `C:\Program Files\PostgreSQL\16\bin`
(versionumero asennuksen mukaan) tai käytä pgAdminin Query Toolia.

## Tarkistus

```powershell
psql -U postgres -d louhiads -c "SELECT name, display_status FROM v_campaign_status"
```

Odotettu tulos: SaaShop = active, Getafix = pending, Pilvi = ended,
Goodi = draft, Louhi = paused.

## Tietomalli

```
environments 1─* placements             (placements.environment -> environments.name)
advertisers 1─* campaigns
advertisers 1─* creatives                (kampanja ei ole mainokselle pakollinen)
placings = sijoitus: creative + placement (+ valinnainen campaign)
           omalla painolla, prioriteetilla, aikataululla ja tilalla
placings 1─* impressions 1─* clicks      (klikki kuuluu näyttöön)
placings 1─* targeting_rules
campaigns *─* placements                 (campaign_placements = kampanjan sallitut paikat)
```

- **Taulun nimi** `placings` (monikko), koska `PLACING` on PostgreSQL:n varattu sana.
- **Kampanjan tila:** tallennetaan `draft / active / paused / archived`.
  "Odottaa alkamista" ja "Päättynyt" lasketaan päivämääristä näkymässä `v_campaign_status`.
  Sijoitus näkyy, kun sijoitus (ja sen mahdollinen kampanja) on aktiivinen ja voimassa.
  Kampanjan sijoituksen mainospaikan on lisäksi oltava kampanjan sallituissa paikoissa.
- **Näyttöjako:** jokainen näytettävä mainos arvotaan painoarvonsa (`placings.priority`, 0–100) suhteessa:
  osuus = painoarvo / paikan painoarvojen summa. `weight` ja `campaigns.priority` eivät ole käytössä.
- **Raportointi:** `v_daily_stats` antaa päivä × sijoitus -tason näytöt, klikit ja CTR:n
  (mukana mainostaja, mainos, kampanja ja paikka; Helsingin aikavyöhyke). Tästä tehdään myös CSV-vienti.
- **Tietosuoja:** näyttö- ja klikkitauluihin ei tallenneta IP-osoitteita eikä käyttäjätunnisteita.
